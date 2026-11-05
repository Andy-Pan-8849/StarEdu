"""文件：测试——审计日志只增不改（集成）
测什么：应用账号只能追加审计记录，不能修改、删除，也不能读取（数据库层面的权限保证）。
"""

from collections.abc import Callable

import pytest
from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncConnection
from starit_core.audit import write_audit
from starit_core.auth import Identity

pytestmark = pytest.mark.integration


async def test_the_application_can_append_but_not_change_or_read(
    owner_conn: AsyncConnection, make_identity: Callable[..., Identity]
) -> None:
    actor = make_identity({"staff"}, user_id="audited-user")
    await owner_conn.execute(text("SET LOCAL ROLE ai_app"))
    await write_audit(
        owner_conn, action="chat.query", actor=actor, query_text="What is the bonus formula?",
        doc_ids=["d1", "d2"], filtered_count=3,
    )  # fmt: skip

    for statement in (
        "UPDATE ai.audit_log SET action = 'edited'",
        "DELETE FROM ai.audit_log",
        "TRUNCATE ai.audit_log",
        "SELECT count(*) FROM ai.audit_log",
    ):
        with pytest.raises(ProgrammingError, match="permission denied"):
            async with owner_conn.begin_nested():
                await owner_conn.execute(text(statement))

    await owner_conn.execute(text("RESET ROLE"))
    row = (
        await owner_conn.execute(
            text("SELECT user_id, roles, action, query_text, doc_ids, filtered_count "
                 "FROM ai.audit_log WHERE user_id = 'audited-user'")
        )
    ).one()  # fmt: skip
    assert row == ("audited-user", ["staff"], "chat.query", "What is the bonus formula?",
                   ["d1", "d2"], 3)  # fmt: skip
