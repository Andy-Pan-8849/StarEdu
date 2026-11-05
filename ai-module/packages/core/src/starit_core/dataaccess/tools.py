"""文件：dataaccess/tools.py
作用：固定的数据工具——助手（以及任何 MCP 客户端）可以按名字调用的“查询函数”。
工具清单：search_documents 搜文档 / list_assignments 作业 / list_students 学员 /
get_student_progress 学员进度 / get_expense_claim_status 报销状态 / list_my_expense_claims
  我的报销。
主要思想：
  - 每个工具的参数都用 pydantic 模型严格校验（extra="forbid"），不合格返回 invalid_argument。
  - 查询都通过 `ai_sql` 视图、以调用者身份执行，行级权限由数据库保证；
    工具里的角色检查只是早拒绝。
  - 返回统一格式：成功 {"ok": true, ...}，失败 {"ok": false, "error": {"code", "message"}}。
  - 同一份代码既在 MCP 服务器背后运行，也能在进程内被测试/评测直接调用，两边行为一致。
错误码：forbidden 角色无权 / not_found 看得见的里面没有（存在但越权也显示成这个，不泄露）/
invalid_argument 参数不对 / internal_error 内部错误。每次调用（成功或失败）都写审计。
"""

import logging
from collections.abc import Awaitable, Callable
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from starit_core import telemetry
from starit_core.audit import write_audit
from starit_core.auth import Identity
from starit_core.config import Settings
from starit_core.dataaccess.schema import can_use_view
from starit_core.embeddings import EmbeddingClient
from starit_core.permissions import COMPANY_WIDE_ROLES
from starit_core.retrieval import retrieve
from starit_core.sqlaccess import run_as_identity

log = logging.getLogger(__name__)

# search_documents 的 domain 参数对应的文档编号前缀
DOMAIN_PREFIXES = {"hr": "HR-", "finance": "FIN-", "tech": "TS-"}
# 课程方向
Program = Literal["java", "python", "typescript"]


class ToolError(Exception):
    """工具以可预期的方式失败：code 是错误码，message 可以安全地展示给调用者。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class DataToolsClient(Protocol):
    """助手需要的接口：以某人的身份调用一个工具。进程内实现和 MCP 实现都满足它。"""

    async def call(
        self, identity: Identity, name: str, arguments: dict[str, Any]
    ) -> dict[str, Any]: ...


class _Args(BaseModel):
    """所有工具参数的基类：不允许多余字段，字符串自动去首尾空白。"""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


# —— 以下是各工具的参数模型：字段类型、范围、正则都在这里约束
class SearchDocumentsArgs(_Args):
    query: str = Field(min_length=1, max_length=500)
    domain: Literal["hr", "finance", "tech"] | None = None
    top_k: int = Field(default=5, ge=1, le=8)


class ListAssignmentsArgs(_Args):
    program: Program | None = None
    due_after: date | None = None
    due_before: date | None = None


class ListStudentsArgs(_Args):
    program: Program | None = None
    cohort: str | None = Field(default=None, max_length=20)
    status: Literal["active", "withdrawn"] | None = None
    campus_id: str | None = Field(default=None, pattern=r"^[A-Za-z]{2}$")
    name_contains: str | None = Field(default=None, min_length=1, max_length=50)
    limit: int = Field(default=50, ge=1, le=100)


class StudentProgressArgs(_Args):
    student_id: str = Field(pattern=r"^S\d{4,6}$")


class ClaimStatusArgs(_Args):
    claim_id: str = Field(pattern=r"^C\d{4,6}$")


class MyClaimsArgs(_Args):
    status: Literal["paid", "approved", "pending", "rejected"] | None = None
    limit: int = Field(default=20, ge=1, le=100)


def _plain(value: Any) -> Any:
    """把数据库返回的日期/小数转成 JSON 能表示的类型。"""
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


def _rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """把整批行都做一遍 _plain。"""
    return [{k: _plain(v) for k, v in row.items()} for row in rows]


def _need(identity: Identity, view: str) -> None:
    """调用者的角色必须能用该视图，否则抛 forbidden（早拒绝；真正的过滤在视图里）。"""
    if not can_use_view(identity.roles, view):
        raise ToolError("forbidden", "Your role does not give access to this data.")


def _like(text_: str) -> str:
    """把用户输入转成 LIKE 的模糊匹配串，并转义 % 和 _，让它们按字面匹配。"""
    escaped = text_.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


# 工具处理函数的类型：(连接, 身份, 已校验参数) -> 结果字典
Handler = Callable[[AsyncConnection, Identity, Any], Awaitable[dict[str, Any]]]


class DataTools:
    """数据工具集合：登记工具名 -> (参数模型, 处理函数)，并统一负责校验、审计和错误转换。"""

    def __init__(
        self,
        engine: AsyncEngine,
        settings: Settings,
        embedder: EmbeddingClient | None = None,
        *,
        retrieve_fn: Callable[..., Awaitable[Any]] = retrieve,
    ) -> None:
        self._engine = engine
        self._settings = settings
        self._embedder = embedder
        self._retrieve = retrieve_fn
        self._tools: dict[str, tuple[type[_Args], Handler]] = {
            "search_documents": (SearchDocumentsArgs, self._search_documents),
            "list_assignments": (ListAssignmentsArgs, self._list_assignments),
            "list_students": (ListStudentsArgs, self._list_students),
            "get_student_progress": (StudentProgressArgs, self._student_progress),
            "get_expense_claim_status": (ClaimStatusArgs, self._claim_status),
            "list_my_expense_claims": (MyClaimsArgs, self._my_claims),
        }

    @property
    def names(self) -> list[str]:
        return list(self._tools)

    async def call(
        self,
        identity: Identity,
        name: str,
        arguments: dict[str, Any],
        *,
        token: str | None = None,  # the MCP backend needs it; in-process, identity is enough
    ) -> dict[str, Any]:
        """按名字调用一个工具。

        参数：identity 调用者；name 工具名；arguments 参数字典；
          token 原始令牌（只有 MCP 后端需要，进程内有 identity 就够）。
        返回：统一格式的结果字典。同时记录链路和工具调用指标。
        """
        with telemetry.span("tool.call", {"tool": name}) as active:
            outcome = await self._call(identity, name, arguments)
            result = "ok" if outcome.get("ok") else str(outcome["error"]["code"])
            active.set_attribute("tool.result", result)
            if result == "internal_error":
                telemetry.fail(active, result)
        telemetry.current().tool_calls.add(1, {"tool": name, "result": result})
        return outcome

    async def _call(
        self, identity: Identity, name: str, arguments: dict[str, Any]
    ) -> dict[str, Any]:
        """调用的核心流程：找工具 -> 校验参数 -> 在一个事务里执行并写审计 -> 返回。
        工具抛 ToolError 转成对应错误码；其他异常记日志并转成 internal_error；
        失败的调用也会另开事务补写审计。
        """
        outcome: dict[str, Any]
        details: dict[str, Any] = {"tool": name, "arguments": arguments}
        try:
            if name not in self._tools:
                raise ToolError("invalid_argument", f"Unknown tool {name!r}.")
            model, handler = self._tools[name]
            try:
                args = model.model_validate(arguments)
            except ValidationError as exc:
                problems = "; ".join(
                    f"{'.'.join(str(p) for p in e['loc']) or 'arguments'}: {e['msg']}"
                    for e in exc.errors()
                )
                raise ToolError("invalid_argument", problems) from exc
            details["arguments"] = args.model_dump(mode="json")
            async with self._engine.begin() as conn:
                outcome = await handler(conn, identity, args)
                details["row_count"] = outcome.get("row_count")
                await self._audit(conn, identity, name, details, outcome)
            return outcome
        except ToolError as exc:
            outcome = {"ok": False, "error": {"code": exc.code, "message": exc.message}}
        except Exception:
            log.exception("data tool failed", extra={"tool": name})
            outcome = {
                "ok": False,
                "error": {"code": "internal_error", "message": "The lookup failed."},
            }
        await self._audit_failure(identity, name, details, outcome)
        return outcome

    async def _audit(
        self,
        conn: AsyncConnection,
        identity: Identity,
        name: str,
        details: dict[str, Any],
        outcome: dict[str, Any],
    ) -> None:
        """写成功调用的审计：工具名、参数、读到的文档编号、行数。"""
        await write_audit(
            conn,
            action=f"mcp.{name}",
            actor=identity,
            query_text=details["arguments"].get("query"),
            doc_ids=outcome.get("doc_codes", []),
            details={**details, "result": "ok"},
        )

    async def _audit_failure(
        self, identity: Identity, name: str, details: dict[str, Any], outcome: dict[str, Any]
    ) -> None:
        """写失败调用的审计；审计本身再失败只记日志，不影响返回。"""
        try:
            async with self._engine.begin() as conn:
                await write_audit(
                    conn,
                    action=f"mcp.{name}",
                    actor=identity,
                    query_text=(details.get("arguments") or {}).get("query"),
                    details={**details, "result": outcome["error"]["code"]},
                )
        except Exception:
            log.exception("could not audit a failed data tool call")

    # —— 以下是各工具的实现，每个对应一个参数模型
    # --- the tools ----------------------------------------------------------------------

    async def _search_documents(
        self, conn: AsyncConnection, identity: Identity, args: SearchDocumentsArgs
    ) -> dict[str, Any]:
        """搜文档：用 hybrid 检索（有权限过滤），按 domain 前缀筛选后取前 top_k 段。"""
        result = await self._retrieve(
            conn,
            identity,
            args.query,
            mode="hybrid",
            settings=self._settings,
            embedder=self._embedder,
        )
        prefix = DOMAIN_PREFIXES.get(args.domain or "")
        found = [c for c in result.chunks if prefix is None or c.doc_code.startswith(prefix)]
        found = found[: args.top_k]
        return {
            "ok": True,
            "row_count": len(found),
            "doc_codes": sorted({c.doc_code for c in found}),
            "passages": [
                {
                    "doc_code": c.doc_code,
                    "title": c.title,
                    "version": c.version,
                    "heading_path": c.heading_path,
                    "text": c.text,
                }
                for c in found
            ],
        }

    async def _list_assignments(
        self, conn: AsyncConnection, identity: Identity, args: ListAssignmentsArgs
    ) -> dict[str, Any]:
        """列作业，可按课程方向和截止日期范围筛选。"""
        _need(identity, "assignments")
        rows = await run_as_identity(
            conn,
            identity,
            "SELECT assignment_id, program, title, due_date FROM ai_sql.assignments "
            "WHERE (CAST(:program AS text) IS NULL OR program = :program) "
            "AND (CAST(:after AS date) IS NULL OR due_date >= :after) "
            "AND (CAST(:before AS date) IS NULL OR due_date <= :before) "
            "ORDER BY due_date, assignment_id",
            params={"program": args.program, "after": args.due_after, "before": args.due_before},
            max_rows=self._settings.data_max_rows,
            timeout_ms=self._settings.data_statement_timeout_ms,
        )
        return _found("assignments", rows)

    async def _list_students(
        self, conn: AsyncConnection, identity: Identity, args: ListStudentsArgs
    ) -> dict[str, Any]:
        """列学员，可按方向、期别、状态、校区、姓名片段筛选；非总部角色不能点名别的校区。"""
        _need(identity, "students")
        campus = args.campus_id.upper() if args.campus_id else None
        if (
            campus
            and not identity.roles & COMPANY_WIDE_ROLES
            and campus != (identity.campus_id or "").upper()
        ):
            raise ToolError("forbidden", "That campus is outside your scope.")
        rows = await run_as_identity(
            conn,
            identity,
            "SELECT student_id, name, campus_id, program, cohort, status FROM ai_sql.students "
            "WHERE (CAST(:program AS text) IS NULL OR program = :program) "
            "AND (CAST(:cohort AS text) IS NULL OR cohort = :cohort) "
            "AND (CAST(:status AS text) IS NULL OR status = :status) "
            "AND (CAST(:campus AS text) IS NULL OR campus_id = :campus) "
            "AND (CAST(:name AS text) IS NULL OR name ILIKE :name) "
            "ORDER BY student_id LIMIT :limit",
            params={
                "program": args.program,
                "cohort": args.cohort,
                "status": args.status,
                "campus": campus,
                "name": _like(args.name_contains) if args.name_contains else None,
                "limit": args.limit,
            },
            max_rows=args.limit,
            timeout_ms=self._settings.data_statement_timeout_ms,
        )
        return _found("students", rows)

    async def _student_progress(
        self, conn: AsyncConnection, identity: Identity, args: StudentProgressArgs
    ) -> dict[str, Any]:
        """某个学员的进度：基本信息、每份作业提交（迟交、得分）和汇总（提交数、迟交数、平均分）。"""
        _need(identity, "students")
        limits = {
            "max_rows": self._settings.data_max_rows,
            "timeout_ms": self._settings.data_statement_timeout_ms,
        }
        students = await run_as_identity(
            conn,
            identity,
            "SELECT student_id, name, campus_id, program, cohort, status "
            "FROM ai_sql.students WHERE student_id = :id",
            params={"id": args.student_id},
            **limits,
        )
        if not students:
            raise ToolError("not_found", "No such student is visible to you.")
        submissions = await run_as_identity(
            conn,
            identity,
            "SELECT s.assignment_id, a.title, s.submitted_at, s.hours_late, s.raw_score, "
            "s.late_penalty_pct, s.final_score FROM ai_sql.submissions s "
            "JOIN ai_sql.assignments a ON a.assignment_id = s.assignment_id "
            "WHERE s.student_id = :id ORDER BY a.due_date, s.assignment_id",
            params={"id": args.student_id},
            **limits,
        )
        scores = [r["final_score"] for r in submissions if r["final_score"] is not None]
        return {
            "ok": True,
            "row_count": len(submissions),
            "views": ["students", "submissions", "assignments"],
            "student": _rows(students)[0],
            "submissions": _rows(submissions),
            "summary": {
                "submitted": len(submissions),
                "late": sum(1 for r in submissions if (r["hours_late"] or 0) > 0),
                "average_final_score": round(sum(scores) / len(scores), 1) if scores else None,
            },
        }

    async def _claim_status(
        self, conn: AsyncConnection, identity: Identity, args: ClaimStatusArgs
    ) -> dict[str, Any]:
        """查某张报销单的详情；看不到（不存在或越权）统一返回 not_found。"""
        _need(identity, "expense_claims")
        rows = await run_as_identity(
            conn,
            identity,
            "SELECT claim_id, employee_id, campus_id, category, city, nights_or_days, guests, "
            "amount_cny, expense_date, submitted_date, preapproved, status, approver_role "
            "FROM ai_sql.expense_claims WHERE claim_id = :id",
            params={"id": args.claim_id},
            max_rows=1,
            timeout_ms=self._settings.data_statement_timeout_ms,
        )
        if not rows:
            raise ToolError("not_found", "No such claim is visible to you.")
        return {
            "ok": True,
            "row_count": 1,
            "views": ["expense_claims"],
            "claim": _rows(rows)[0],
        }

    async def _my_claims(
        self, conn: AsyncConnection, identity: Identity, args: MyClaimsArgs
    ) -> dict[str, Any]:
        """列出“我”的报销单（用调用者的员工编号），可按状态筛选。"""
        _need(identity, "expense_claims")
        if not identity.employee_id:
            raise ToolError("forbidden", "Your account is not linked to an employee record.")
        rows = await run_as_identity(
            conn,
            identity,
            "SELECT claim_id, category, city, amount_cny, expense_date, submitted_date, status "
            "FROM ai_sql.expense_claims WHERE employee_id = :me "
            "AND (CAST(:status AS text) IS NULL OR status = :status) "
            "ORDER BY submitted_date DESC, claim_id LIMIT :limit",
            params={"me": identity.employee_id, "status": args.status, "limit": args.limit},
            max_rows=args.limit,
            timeout_ms=self._settings.data_statement_timeout_ms,
        )
        return _found("expense_claims", rows, key="claims")


def _found(view: str, rows: list[dict[str, Any]], *, key: str | None = None) -> dict[str, Any]:
    """把查询结果包成成功返回；没有行就抛 not_found。key 指定结果字段名。"""
    if not rows:
        raise ToolError("not_found", "Nothing visible to you matches.")
    return {"ok": True, "row_count": len(rows), "views": [view], key or view: _rows(rows)}
