"""文件：tools.py
作用：把六个数据工具注册到 MCP 服务器上。
主要思想：每个 MCP 工具只做两件事——从请求里的令牌得到调用者身份，然后交给 `DataTools.call`；
具体的校验、查询、审计都在 core 的 DataTools 里，所以 MCP 路径和进程内路径行为完全一致。
值为 None 的可选参数在这里去掉，让 DataTools 用默认值。令牌无效统一返回 forbidden。
"""

import json
from typing import Any

from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.mcpserver import MCPServer
from starit_core.auth import AuthError
from starit_core.dataaccess.tools import DataTools

from starit_mcp_server.auth import JwtTokenVerifier

# 令牌缺失或无效时的统一返回（用 forbidden，不区分原因）
UNAUTHENTICATED = {"ok": False, "error": {"code": "forbidden", "message": "Invalid token."}}


def register_tools(server: MCPServer, tools: DataTools, verifier: JwtTokenVerifier) -> None:
    """把六个工具登记到 server：search_documents、list_assignments、list_students、
    get_student_progress、get_expense_claim_status、list_my_expense_claims。
    """

    # run：所有工具共用的执行入口——取令牌 -> 校验成身份 -> 去掉 None 参数 -> 调 DataTools ->
    #   返回 JSON 文本
    async def run(name: str, arguments: dict[str, Any]) -> str:
        access = get_access_token()
        if access is None:
            return json.dumps(UNAUTHENTICATED)
        try:
            identity = verifier.identity(access.token)
        except AuthError:
            return json.dumps(UNAUTHENTICATED)
        given = {k: v for k, v in arguments.items() if v is not None}
        return json.dumps(await tools.call(identity, name, given), ensure_ascii=False)

    @server.tool(description="Search the policy documents the caller may read.")
    async def search_documents(
        query: str, domain: str | None = None, top_k: int | None = None
    ) -> str:
        return await run("search_documents", {"query": query, "domain": domain, "top_k": top_k})

    @server.tool(description="List course assignments, optionally by program or due date.")
    async def list_assignments(
        program: str | None = None, due_after: str | None = None, due_before: str | None = None
    ) -> str:
        return await run(
            "list_assignments",
            {"program": program, "due_after": due_after, "due_before": due_before},
        )

    @server.tool(description="List students the caller may see, with optional filters.")
    async def list_students(
        program: str | None = None,
        cohort: str | None = None,
        status: str | None = None,
        campus_id: str | None = None,
        name_contains: str | None = None,
        limit: int | None = None,
    ) -> str:
        return await run(
            "list_students",
            {
                "program": program,
                "cohort": cohort,
                "status": status,
                "campus_id": campus_id,
                "name_contains": name_contains,
                "limit": limit,
            },
        )

    @server.tool(description="A student's submissions, late penalties and scores.")
    async def get_student_progress(student_id: str) -> str:
        return await run("get_student_progress", {"student_id": student_id})

    @server.tool(description="The status of one expense claim.")
    async def get_expense_claim_status(claim_id: str) -> str:
        return await run("get_expense_claim_status", {"claim_id": claim_id})

    @server.tool(description="The caller's own expense claims.")
    async def list_my_expense_claims(status: str | None = None, limit: int | None = None) -> str:
        return await run("list_my_expense_claims", {"status": status, "limit": limit})
