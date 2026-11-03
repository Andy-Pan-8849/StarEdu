"""Run a read-only query as a given caller.

Inside one transaction: set the caller's identity as session settings, switch to the
ai_sql_ro role (which can read only the whitelisted ai_sql views), run the query, switch back.
The views read the identity settings and return only the rows that caller may see.

The checks here are the minimum. Statement validation for the SQL Agent (single SELECT, view
and function whitelist) is added with the agent in milestone M6.
"""

import re
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from starit_core.auth import Identity

_READ_ONLY = re.compile(r"^\s*(select|with)\b", re.IGNORECASE)


async def run_as_identity(
    conn: AsyncConnection,
    identity: Identity,
    sql: str,
    *,
    max_rows: int = 200,
    timeout_ms: int = 5000,
) -> list[dict[str, Any]]:
    """Run one SELECT as `identity`. The connection must already be in a transaction."""
    statement = sql.strip().rstrip(";")
    if not _READ_ONLY.match(statement) or ";" in statement:
        raise ValueError("only a single SELECT statement is allowed")

    settings = {
        "app.user_id": identity.user_id,
        "app.roles": ",".join(sorted(identity.roles)),
        "app.campus_id": identity.campus_id or "",
        "app.employee_id": identity.employee_id or "",
        "app.student_id": identity.student_id or "",
    }
    for name, value in settings.items():
        await conn.execute(
            text("SELECT set_config(:name, :value, true)"), {"name": name, "value": value}
        )
    await conn.execute(text(f"SET LOCAL statement_timeout = {int(timeout_ms)}"))
    await conn.execute(text("SET LOCAL ROLE ai_sql_ro"))
    # If the query fails the transaction is aborted and SET LOCAL ends with it.
    result = await conn.execute(text(statement))
    rows = [dict(row) for row in result.mappings().fetchmany(max_rows)]
    await conn.execute(text("RESET ROLE"))
    return rows
