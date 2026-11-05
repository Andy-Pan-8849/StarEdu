"""文件：conversations.py
作用：会话及其消息的读写。用户只能看到自己的会话。
主要思想：
  - 所有按用户查询的函数都带 user_id 条件，“不存在”和“是别人的”返回同样的结果，不泄露别人会话存在。
  - 分页用游标（时间戳 + ID 编码成 base64），比页码在数据变动时更稳定。
  - 归档只是隐藏，不删除（审计记录引用着会话）。
"""

import base64
import json
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from starit_core.auth import Identity


def encode_cursor(timestamp: datetime, row_id: UUID) -> str:
    """把（时间戳, ID）编码成不透明的分页游标字符串。"""
    raw = json.dumps({"t": timestamp.isoformat(), "id": str(row_id)})
    return base64.urlsafe_b64encode(raw.encode()).decode()


def decode_cursor(cursor: str) -> tuple[datetime, UUID]:
    """解码游标；格式不对抛 ValueError。"""
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor.encode()))
        return datetime.fromisoformat(data["t"]), UUID(data["id"])
    except (ValueError, KeyError, TypeError) as exc:
        raise ValueError("invalid cursor") from exc


def _conversation(row: Any) -> dict[str, Any]:
    """把数据库行整理成对外的会话字典。"""
    return {
        "id": row["id"],
        "title": row["title"],
        "archived": row["archived"],
        "session_mode": row["session_mode"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


# 会话查询统一取的列
_COLUMNS = "id, title, archived, session_mode, created_at, updated_at"


async def create_conversation(conn: AsyncConnection, identity: Identity) -> dict[str, Any]:
    """为当前用户新建一个空会话，返回会话字典。"""
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
    """取会话；不存在或属于别人都返回 None。"""
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
    """列出用户的会话，按最近更新倒序，游标分页。

    参数：limit 每页条数；cursor 上一页返回的游标；include_archived 是否包含已归档。
    返回：(会话列表, 下一页游标或 None)。多取一行用来判断是否还有下一页。
    """
    params: dict[str, Any] = {"u": identity.user_id, "limit": limit + 1}
    after = ""
    if cursor:
        stamp, row_id = decode_cursor(cursor)
        # 游标条件：取排在游标位置之后的行（用元组比较，同一时间戳也不会重复或漏掉）
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
    """改会话标题；返回是否真的改到了（不是自己的会话则为 False）。"""
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
    """会话里的消息，最早的在前，游标分页。调用方已确认会话属于当前用户。
    返回：(消息列表, 下一页游标或 None)。
    """
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
    """最近 turns 轮问答（每轮一问一答），按时间从早到晚，用作助手的对话上下文。
    返回：[{"role":..., "content":...}, ...]。
    """
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
