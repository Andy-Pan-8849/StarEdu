"""Conversations and the chat endpoint (design 03, sections 3 and 4)."""

import time
from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncEngine
from starit_core import conversations as store
from starit_core.agent.runtime import AgentRuntime
from starit_core.auth import Identity
from starit_core.config import get_settings
from starit_core.cost import DailyBudget
from starit_core.ratelimit import RateLimiter

from starit_api.deps import (
    get_access_token,
    get_budget,
    get_engine,
    get_identity,
    get_limiter,
    get_runtime,
)
from starit_api.errors import ApiError
from starit_api.limits import check_chat_limits

router = APIRouter(prefix="/conversations", tags=["conversations"])

MAX_MESSAGE_CHARS = 4000


class MessageIn(BaseModel):
    content: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)

    @field_validator("content")
    @classmethod
    def not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("the message is empty")
        return value


class ConversationPatch(BaseModel):
    title: str = Field(min_length=1, max_length=200)


def _iso(value: datetime) -> str:
    return value.isoformat()


def _conversation(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "title": row["title"],
        "archived": row["archived"],
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row["updated_at"]),
    }


async def _owned(engine: AsyncEngine, identity: Identity, conversation_id: UUID) -> dict[str, Any]:
    async with engine.connect() as conn:
        found = await store.get_conversation(conn, identity, conversation_id)
    if found is None:  # missing, or someone else's: the same answer, so existence is not revealed
        raise ApiError(404, "not_found", "Conversation not found")
    return found


@router.post("", status_code=201)
async def create_conversation(
    identity: Identity = Depends(get_identity), engine: AsyncEngine = Depends(get_engine)
) -> dict[str, Any]:
    async with engine.begin() as conn:
        return _conversation(await store.create_conversation(conn, identity))


@router.get("")
async def list_conversations(
    limit: int = Query(20, ge=1, le=100),
    cursor: str | None = None,
    identity: Identity = Depends(get_identity),
    engine: AsyncEngine = Depends(get_engine),
) -> dict[str, Any]:
    try:
        async with engine.connect() as conn:
            items, next_cursor = await store.list_conversations(
                conn, identity, limit=limit, cursor=cursor
            )
    except ValueError as exc:
        raise ApiError(422, "validation_error", "Invalid cursor") from exc
    return {"items": [_conversation(i) for i in items], "next_cursor": next_cursor}


@router.get("/{conversation_id}")
async def get_conversation(
    conversation_id: UUID,
    identity: Identity = Depends(get_identity),
    engine: AsyncEngine = Depends(get_engine),
) -> dict[str, Any]:
    return _conversation(await _owned(engine, identity, conversation_id))


@router.patch("/{conversation_id}")
async def rename_conversation(
    conversation_id: UUID,
    body: ConversationPatch,
    identity: Identity = Depends(get_identity),
    engine: AsyncEngine = Depends(get_engine),
) -> dict[str, Any]:
    await _owned(engine, identity, conversation_id)
    async with engine.begin() as conn:
        await store.rename_conversation(conn, identity, conversation_id, body.title.strip())
    return _conversation(await _owned(engine, identity, conversation_id))


@router.delete("/{conversation_id}", status_code=204)
async def archive_conversation(
    conversation_id: UUID,
    identity: Identity = Depends(get_identity),
    engine: AsyncEngine = Depends(get_engine),
) -> Response:
    await _owned(engine, identity, conversation_id)
    async with engine.begin() as conn:
        await store.archive_conversation(conn, identity, conversation_id)
    return Response(status_code=204)


@router.get("/{conversation_id}/messages")
async def list_messages(
    conversation_id: UUID,
    limit: int = Query(20, ge=1, le=100),
    cursor: str | None = None,
    identity: Identity = Depends(get_identity),
    engine: AsyncEngine = Depends(get_engine),
) -> dict[str, Any]:
    await _owned(engine, identity, conversation_id)
    try:
        async with engine.connect() as conn:
            items, next_cursor = await store.list_messages(
                conn, conversation_id, limit=limit, cursor=cursor
            )
    except ValueError as exc:
        raise ApiError(422, "validation_error", "Invalid cursor") from exc
    return {
        "items": [
            {
                "id": str(m["id"]),
                "role": m["role"],
                "content": m["content"],
                "citations": m["citations"],
                "run_id": str(m["run_id"]) if m["run_id"] else None,
                "created_at": _iso(m["created_at"]),
            }
            for m in items
        ],
        "next_cursor": next_cursor,
    }


@router.post("/{conversation_id}/messages")
async def post_message(
    request: Request,
    conversation_id: UUID,
    body: MessageIn,
    identity: Identity = Depends(get_identity),
    engine: AsyncEngine = Depends(get_engine),
    runtime: AgentRuntime = Depends(get_runtime),
    limiter: RateLimiter = Depends(get_limiter),
    access_token: str | None = Depends(get_access_token),
    budget: DailyBudget | None = Depends(get_budget),
) -> dict[str, Any]:
    conversation = await _owned(engine, identity, conversation_id)
    if conversation["archived"]:
        raise ApiError(409, "conflict", "This conversation is archived")
    await check_chat_limits(request, get_settings(), limiter, budget, identity.user_id, time.time())
    result = await runtime.run(
        identity, conversation_id, body.content.strip(), access_token=access_token
    )
    return {
        "run_id": str(result.run_id),
        "message": {
            "id": str(result.message_id),
            "role": "assistant",
            "content": result.content,
            "citations": result.citations,
        },
        "end_state": result.end_state,
        "end_reason": result.end_reason,
    }
