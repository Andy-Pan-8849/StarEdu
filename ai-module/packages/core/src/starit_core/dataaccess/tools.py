"""The fixed data tools: what the assistant (and any other MCP client) can ask for by name.

Every tool takes validated arguments, reads through the `ai_sql` views as the caller, and answers
with the same shape: {"ok": true, ...} or {"ok": false, "error": {"code", "message"}}. The same
code runs behind the MCP server and in-process (tests, evaluation), so both behave alike.

Error codes: forbidden (the role cannot use this data), not_found (nothing visible matches; a
record that exists but is out of scope looks the same), invalid_argument, internal_error.
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

DOMAIN_PREFIXES = {"hr": "HR-", "finance": "FIN-", "tech": "TS-"}
Program = Literal["java", "python", "typescript"]


class ToolError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class DataToolsClient(Protocol):
    """What the agent needs: call a tool as a person. Local and MCP implementations both fit."""

    async def call(
        self, identity: Identity, name: str, arguments: dict[str, Any]
    ) -> dict[str, Any]: ...


class _Args(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


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
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


def _rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{k: _plain(v) for k, v in row.items()} for row in rows]


def _need(identity: Identity, view: str) -> None:
    if not can_use_view(identity.roles, view):
        raise ToolError("forbidden", "Your role does not give access to this data.")


def _like(text_: str) -> str:
    escaped = text_.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


Handler = Callable[[AsyncConnection, Identity, Any], Awaitable[dict[str, Any]]]


class DataTools:
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

    # --- the tools ----------------------------------------------------------------------

    async def _search_documents(
        self, conn: AsyncConnection, identity: Identity, args: SearchDocumentsArgs
    ) -> dict[str, Any]:
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
    if not rows:
        raise ToolError("not_found", "Nothing visible to you matches.")
    return {"ok": True, "row_count": len(rows), "views": [view], key or view: _rows(rows)}
