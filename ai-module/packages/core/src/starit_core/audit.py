"""Append-only audit trail (ai.audit_log).

The application role may only INSERT into this table, so there is no RETURNING and no way to
change or remove a record from application code.
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
