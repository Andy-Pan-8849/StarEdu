"""文件：audit.py
作用：只增不改的审计日志（表 ai.audit_log）。
主要思想：应用账号对这张表只有 INSERT 权限，所以代码里既不能改也不能删记录，
INSERT 之后也不带 RETURNING（读也需要 SELECT 权限）。审计里只记元数据，不记模型回答原文。
"""

import json
from collections.abc import Sequence
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from starit_core.auth import Identity


async def write_audit(
    conn: AsyncConnection,
    *,
    action: str,
    actor: Identity | None = None,
    run_id: str | None = None,
    query_text: str | None = None,
    doc_ids: Sequence[str] = (),
    filtered_count: int | None = None,
    ip: str | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    """写一条审计记录。

    参数：conn 数据库连接（通常和业务写入在同一事务）；action 动作名（如 chat.query）；
      actor 谁做的；run_id 关联的运行；query_text 用户问题；doc_ids 读到的文档；
      filtered_count 被权限过滤掉的命中数；ip 来源 IP；details 其他详情(JSON)。
    """
    await conn.execute(
        text(
            """
            INSERT INTO ai.audit_log
                (user_id, roles, action, run_id, query_text, doc_ids, filtered_count, ip, details)
            VALUES
                (:user_id, CAST(:roles AS jsonb), :action, CAST(:run_id AS uuid), :query_text,
                 CAST(:doc_ids AS text[]), :filtered_count, :ip, CAST(:details AS jsonb))
            """
        ),
        {
            "user_id": actor.user_id if actor else None,
            "roles": json.dumps(sorted(actor.roles) if actor else []),
            "action": action,
            "run_id": run_id,
            "query_text": query_text,
            "doc_ids": list(doc_ids),
            "filtered_count": filtered_count,
            "ip": ip,
            "details": json.dumps(details or {}, default=str),
        },
    )
