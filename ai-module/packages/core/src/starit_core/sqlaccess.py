"""文件：sqlaccess.py
作用：以某个调用者的身份执行一条只读查询。
主要思想（数据权限的核心）：在同一个事务里 ①把调用者身份写进会话设置(app.user_id 等)，
②用 SET LOCAL ROLE 切换到只能读白名单视图的 ai_sql_ro 角色，③执行查询，④切回。
视图自己读取这些会话设置，只返回该调用者有权看的行——所以即使 SQL 是模型写的，
它也越不出视图和身份给的范围。这里的检查是最低限度的；对 SQL 的完整校验在 dataaccess/sqlguard.py。
"""

import re
from collections.abc import Mapping
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from starit_core.auth import Identity

# 只接受以 SELECT 或 WITH 开头的语句
_READ_ONLY = re.compile(r"^\s*(select|with)\b", re.IGNORECASE)
# 匹配单个冒号（::类型转换除外），没有参数时要转义，否则 '12:30' 会被当成绑定参数
_COLON = re.compile(r"(?<!:):(?!:)")


async def run_as_identity(
    conn: AsyncConnection,
    identity: Identity,
    sql: str,
    *,
    params: Mapping[str, Any] | None = None,
    max_rows: int = 200,
    timeout_ms: int = 5000,
) -> list[dict[str, Any]]:
    """以 identity 的身份执行一条 SELECT。

    参数：conn 必须已经处于事务中；identity 调用者；sql 单条查询；params 绑定参数；
      max_rows 最多返回几行；timeout_ms 语句超时（毫秒）。
    返回：行字典列表。不是单条 SELECT 抛 ValueError。
    """
    statement = sql.strip().rstrip(";")
    if not _READ_ONLY.match(statement) or ";" in statement:
        raise ValueError("only a single SELECT statement is allowed")

    # 把身份写入事务级会话设置，视图据此过滤行
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
    # 设超时，再切到只读角色；SET LOCAL 只在本事务内有效，出错回滚时一并消失
    await conn.execute(text(f"SET LOCAL statement_timeout = {int(timeout_ms)}"))
    await conn.execute(text("SET LOCAL ROLE ai_sql_ro"))
    # If the query fails the transaction is aborted and SET LOCAL ends with it.
    # Without parameters, a colon in a string literal ('12:30') must not be read as a bind name.
    statement = statement if params else _COLON.sub(r"\\:", statement)
    result = await conn.execute(text(statement), params or {})
    rows = [dict(row) for row in result.mappings().fetchmany(max_rows)]
    await conn.execute(text("RESET ROLE"))
    return rows
