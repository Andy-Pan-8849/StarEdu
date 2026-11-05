"""文件：conversations.py
作用：会话与聊天的 HTTP 接口（设计见 docs/design/03 第 3、4 节）。
接口：POST /conversations 新建；GET 列表（游标分页）；GET/PATCH/DELETE 单个（改标题、归档）；
GET /{id}/messages 消息列表；POST /{id}/messages 发一条消息并得到助手的回答。
主要思想：
  - 所有会话接口先过 _owned：不存在和是别人的统一 404，不泄露别人会话的存在。
  - 发消息有两种返回方式：普通请求一次性返回 JSON；带 `Accept: text/event-stream` 时返回 SSE
    事件流。
  - 流式时，助手运行在独立的任务里，客户端中途断开运行也会跑完、回答也会存下来，
    用户回来就能看到；每 15 秒发一次 keepalive 注释防止代理把空闲连接断掉。
  - 限流和所有权检查都在流开始之前完成，被拒绝的请求直接得到普通的 4xx/429 响应。
"""

import asyncio
import json
import time
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import StreamingResponse
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

# 单条消息最大长度
MAX_MESSAGE_CHARS = 4000


class MessageIn(BaseModel):
    """发消息的请求体：content 非空、不超过上限，且不能全是空白。"""

    content: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)

    @field_validator("content")
    @classmethod
    def not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("the message is empty")
        return value


class ConversationPatch(BaseModel):
    """改会话的请求体：新标题。"""

    title: str = Field(min_length=1, max_length=200)


def _iso(value: datetime) -> str:
    return value.isoformat()


def _conversation(row: dict[str, Any]) -> dict[str, Any]:
    """整理会话给前端：ID 转字符串，时间转 ISO 格式。"""
    return {
        "id": str(row["id"]),
        "title": row["title"],
        "archived": row["archived"],
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row["updated_at"]),
    }


async def _owned(engine: AsyncEngine, identity: Identity, conversation_id: UUID) -> dict[str, Any]:
    """取属于当前用户的会话；不存在或属于别人都抛同样的 404。"""
    async with engine.connect() as conn:
        found = await store.get_conversation(conn, identity, conversation_id)
    if found is None:  # missing, or someone else's: the same answer, so existence is not revealed
        raise ApiError(404, "not_found", "Conversation not found")
    return found


@router.post("", status_code=201)
async def create_conversation(
    identity: Identity = Depends(get_identity), engine: AsyncEngine = Depends(get_engine)
) -> dict[str, Any]:
    """新建一个会话。"""
    async with engine.begin() as conn:
        return _conversation(await store.create_conversation(conn, identity))


@router.get("")
async def list_conversations(
    limit: int = Query(20, ge=1, le=100),
    cursor: str | None = None,
    identity: Identity = Depends(get_identity),
    engine: AsyncEngine = Depends(get_engine),
) -> dict[str, Any]:
    """当前用户的会话列表，按最近更新倒序，游标分页。"""
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
    """取单个会话。"""
    return _conversation(await _owned(engine, identity, conversation_id))


@router.patch("/{conversation_id}")
async def rename_conversation(
    conversation_id: UUID,
    body: ConversationPatch,
    identity: Identity = Depends(get_identity),
    engine: AsyncEngine = Depends(get_engine),
) -> dict[str, Any]:
    """改会话标题。"""
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
    """归档会话（隐藏，不删除；审计记录还引用着它）。"""
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
    """会话里的消息，最早的在前，游标分页，附带引用信息。"""
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


# SSE 空闲多少秒发一次 keepalive
KEEPALIVE_SECONDS = 15.0


def _wants_stream(request: Request) -> bool:
    """请求的 Accept 头里是否要求 text/event-stream（即要流式）。"""
    return "text/event-stream" in request.headers.get("accept", "")


def _sse(name: str, data: dict[str, Any]) -> str:
    """把一个事件格式化成 SSE 文本：event: 名字 / data: JSON，空行结束。"""
    return f"event: {name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def _event_stream(
    runtime: AgentRuntime,
    identity: Identity,
    conversation_id: UUID,
    content: str,
    access_token: str | None,
) -> AsyncIterator[str]:
    """生成一次运行的 SSE 文本流。

    运行放在独立的任务里，通过队列把事件交给这里；这里等队列的同时每 15 秒发一次 keepalive。
    客户端断开时本生成器被取消，但运行任务被 _running 集合引用着，会继续跑完并存下回答。
    运行抛异常时发一个 error 事件，保证流以事件结束而不是断开的连接。
    """
    queue: asyncio.Queue[tuple[str, dict[str, Any]] | None] = asyncio.Queue()

    async def sink(name: str, data: dict[str, Any]) -> None:
        await queue.put((name, data))

    async def work() -> None:
        try:
            await runtime.run(
                identity, conversation_id, content, access_token=access_token, on_event=sink
            )
        except Exception as exc:  # the stream must end with an event, not a broken connection
            await queue.put(("error", {"code": "internal", "message": type(exc).__name__}))
        finally:
            await queue.put(None)

    task = asyncio.create_task(work())
    _running.add(task)
    task.add_done_callback(_running.discard)
    while True:
        try:
            item = await asyncio.wait_for(queue.get(), KEEPALIVE_SECONDS)
        except TimeoutError:
            yield ": keepalive\n\n"
            continue
        if item is None:
            return
        yield _sse(*item)


# 保存正在运行的任务的引用：没有引用的任务可能被垃圾回收而中途消失
_running: set[asyncio.Task[None]] = set()  # keeps runs alive when nobody is listening


@router.post("/{conversation_id}/messages", response_model=None)
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
) -> Any:
    """发一条消息。

    顺序：确认会话归当前用户且未归档 -> 检查三道限制 -> 按 Accept 选择返回方式：
    流式返回 SSE 事件流；否则等运行结束一次性返回
    {run_id, message{id, role, content, citations}, end_state, end_reason}。
    """
    conversation = await _owned(engine, identity, conversation_id)
    if conversation["archived"]:
        raise ApiError(409, "conflict", "This conversation is archived")
    await check_chat_limits(request, get_settings(), limiter, budget, identity.user_id, time.time())
    if _wants_stream(request):
        return StreamingResponse(
            _event_stream(runtime, identity, conversation_id, body.content.strip(), access_token),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )
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
