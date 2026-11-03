"""Conversations and their messages. A user can only see their own."""

import base64
import json
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from starit_core.auth import Identity


def encode_cursor(timestamp: datetime, row_id: UUID) -> str:
    raw = json.dumps({"t": timestamp.isoformat(), "id": str(row_id)})
    return base64.urlsafe_b64encode(raw.encode()).decode()


def decode_cursor(cursor: str) -> tuple[datetime, UUID]:
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor.encode()))
        return datetime.fromisoformat(data["t"]), UUID(data["id"])
    except (ValueError, KeyError, TypeError) as exc:
        raise ValueError("invalid cursor") from exc


def _conversation(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "archived": row["archived"],
        "session_mode": row["session_mode"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


_COLUMNS = "id, title, archived, session_mode, created_at, updated_at"


async def create_conversation(conn: AsyncConnection, identity: Identity) -> dict[str, Any]:
    row = (
        (
            await conn.execute(
                text(f"INSERT INTO ai.conversations (user_id) VALUES (:u) RETURNING {_COLUMNS}"),
                {"u": identity.user_id},
            )
        )
        .mappings()
        .one()
    )
    return _conversation(row)


async def get_conversation(
    conn: AsyncConnection, identity: Identity, conversation_id: UUID
) -> dict[str, Any] | None:
    """The conversation, or None if it does not exist or belongs to someone else."""
    row = (
        (
            await conn.execute(
                text(f"SELECT {_COLUMNS} FROM ai.conversations WHERE id = :id AND user_id = :u"),
                {"id": conversation_id, "u": identity.user_id},
            )
        )
        .mappings()
        .first()
    )
    return _conversation(row) if row else None


async def list_conversations(
    conn: AsyncConnection,
    identity: Identity,
    *,
    limit: int = 20,
    cursor: str | None = None,
    include_archived: bool = False,
) -> tuple[list[dict[str, Any]], str | None]:
    params: dict[str, Any] = {"u": identity.user_id, "limit": limit + 1}
    after = ""
    if cursor:
        stamp, row_id = decode_cursor(cursor)
        after = "AND (updated_at, id) < (:t, :i)"
        params.update({"t": stamp, "i": row_id})
    archived = "" if include_archived else "AND NOT archived"
    rows = (
        (
            await conn.execute(
                text(
                    f"SELECT {_COLUMNS} FROM ai.conversations "
                    f"WHERE user_id = :u {archived} {after} "
                    "ORDER BY updated_at DESC, id DESC LIMIT :limit"
                ),
                params,
            )
        )
        .mappings()
        .all()
    )
    items = [_conversation(r) for r in rows[:limit]]
    more = len(rows) > limit
    return items, encode_cursor(items[-1]["updated_at"], items[-1]["id"]) if more else None


async def rename_conversation(
    conn: AsyncConnection, identity: Identity, conversation_id: UUID, title: str
) -> bool:
    result = await conn.execute(
        text(
            "UPDATE ai.conversations SET title = :t, updated_at = now() "
            "WHERE id = :id AND user_id = :u"
        ),
        {"t": title, "id": conversation_id, "u": identity.user_id},
    )
    return result.rowcount > 0


async def archive_conversation(
    conn: AsyncConnection, identity: Identity, conversation_id: UUID
) -> bool:
    """Archiving hides a conversation; nothing is deleted (the audit trail refers to it)."""
    result = await conn.execute(
        text(
            "UPDATE ai.conversations SET archived = true, updated_at = now() "
            "WHERE id = :id AND user_id = :u"
        ),
        {"id": conversation_id, "u": identity.user_id},
    )
    return result.rowcount > 0


async def list_messages(
    conn: AsyncConnection,
    conversation_id: UUID,
    *,
    limit: int = 20,
    cursor: str | None = None,
) -> tuple[list[dict[str, Any]], str | None]:
    """Messages oldest first. The caller has already checked the conversation is theirs."""
    params: dict[str, Any] = {"c": conversation_id, "limit": limit + 1}
    after = ""
    if cursor:
        stamp, row_id = decode_cursor(cursor)
        after = "AND (created_at, id) > (:t, :i)"
        params.update({"t": stamp, "i": row_id})
    rows = (
        (
            await conn.execute(
                text(
                    "SELECT id, run_id, role, content, citations, created_at FROM ai.messages "
                    f"WHERE conversation_id = :c {after} ORDER BY created_at, id LIMIT :limit"
                ),
                params,
            )
        )
        .mappings()
        .all()
    )
    items = [dict(r) for r in rows[:limit]]
    more = len(rows) > limit
    return items, encode_cursor(items[-1]["created_at"], items[-1]["id"]) if more else None


async def recent_turns(
    conn: AsyncConnection, conversation_id: UUID, turns: int
) -> list[dict[str, str]]:
    """The last `turns` question-and-answer pairs, oldest first, as role and content."""
    rows = (
        (
            await conn.execute(
                text(
                    "SELECT role, content FROM ai.messages WHERE conversation_id = :c "
                    "ORDER BY created_at DESC, id DESC LIMIT :n"
                ),
                {"c": conversation_id, "n": turns * 2},
            )
        )
        .mappings()
        .all()
    )
    return [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]
