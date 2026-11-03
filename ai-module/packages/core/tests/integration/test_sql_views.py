"""The ai_sql views return only the rows a caller may see, and the guard rails hold."""

import csv
import json
from collections.abc import Callable
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncConnection
from starit_core.auth import Identity
from starit_core.dataaccess.schema import VIEWS, can_use_view
from starit_core.seed_biz import load_biz
from starit_core.sqlaccess import run_as_identity

pytestmark = pytest.mark.integration

SAMPLE_DATA = Path(__file__).resolve().parents[4] / "sample-data"
PRIMARY_KEY = {
    "campuses": "campus_id", "assignments": "assignment_id", "students": "student_id",
    "submissions": "submission_id", "support_tickets": "ticket_id", "employees": "employee_id",
    "expense_claims": "claim_id",
}  # fmt: skip


def read_csv(name: str) -> list[dict[str, str]]:
    with open(SAMPLE_DATA / "structured" / f"{name}.csv", newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def accounts() -> list[dict[str, str]]:
    with open(SAMPLE_DATA / "demo-accounts.csv", newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def identity_of(account: dict[str, str], make_identity: Callable[..., Identity]) -> Identity:
    student = account["subject_type"] == "student"
    return make_identity(
        {account["role"]},
        user_id=account["username"],
        campus_id=account["campus_id"],
        level=account["level"] or None,
        employee_id=None if student else account["subject_id"],
        student_id=account["subject_id"] if student else None,
    )


def oracle(table: str, account: dict[str, str]) -> set[str]:
    """Who sees what, written from the README table, independent of the views."""
    role, campus, subject = account["role"], account["campus_id"], account["subject_id"]
    rows = read_csv(table)
    key = PRIMARY_KEY[table]
    if table in ("campuses", "assignments"):
        return {r[key] for r in rows}
    if role not in ("student", "staff", "manager", "hr", "finance"):
        return set()
    if role in ("hr", "finance"):
        return {r[key] for r in rows}
    if table in ("employees", "expense_claims"):
        if role == "manager":
            return {r[key] for r in rows if r["campus_id"] == campus}
        if role == "staff":
            return {r[key] for r in rows if r["employee_id"] == subject}
        return set()
    students_at_campus = {r["student_id"] for r in read_csv("students") if r["campus_id"] == campus}
    if table == "students":
        if role in ("staff", "manager"):
            return {r[key] for r in rows if r["campus_id"] == campus}
        return {r[key] for r in rows if r["student_id"] == subject}
    if table == "support_tickets":
        if role in ("staff", "manager"):
            return {r[key] for r in rows if r["campus_id"] == campus}
        return {
            r[key]
            for r in rows
            if r["requester_type"] == "student" and r["requester_id"] == subject
        }
    if table == "submissions":
        if role in ("staff", "manager"):
            return {r[key] for r in rows if r["student_id"] in students_at_campus}
        return {r[key] for r in rows if r["student_id"] == subject}
    raise AssertionError(table)


@pytest.fixture
async def seeded(owner_conn: AsyncConnection) -> AsyncConnection:
    await owner_conn.run_sync(lambda sync_conn: load_biz(sync_conn, SAMPLE_DATA / "structured"))
    return owner_conn


@pytest.mark.parametrize("account", accounts(), ids=lambda a: a["username"])
async def test_every_view_returns_exactly_the_visible_rows(
    seeded: AsyncConnection, make_identity: Callable[..., Identity], account: dict[str, str]
) -> None:
    identity = identity_of(account, make_identity)
    for table, key in PRIMARY_KEY.items():
        rows = await run_as_identity(
            seeded, identity, f"SELECT {key} FROM ai_sql.{table}", max_rows=10_000
        )
        assert {r[key] for r in rows} == oracle(table, account), (account["username"], table)


@pytest.mark.parametrize("account", accounts(), ids=lambda a: a["username"])
def test_the_guards_role_table_agrees_with_the_views(account: dict[str, str]) -> None:
    """The guard refuses early using a role table. Whatever it refuses, the views must return
    nothing for (it may allow a view that happens to be empty for this person)."""
    for table in PRIMARY_KEY:
        if not can_use_view(frozenset({account["role"]}), table):
            assert not oracle(table, account), (account["username"], table)


async def test_the_schema_description_matches_the_views(seeded: AsyncConnection) -> None:
    for name, view in VIEWS.items():
        columns = (
            (
                await seeded.execute(
                    text(
                        "SELECT column_name FROM information_schema.columns "
                        "WHERE table_schema = 'ai_sql' AND table_name = :t ORDER BY ordinal_position"
                    ),
                    {"t": name},
                )
            )
            .scalars()
            .all()
        )
        assert [c for c, _, _ in view.columns] == list(columns), name


async def test_without_an_identity_every_view_is_empty(seeded: AsyncConnection) -> None:
    await seeded.execute(text("SET LOCAL ROLE ai_sql_ro"))
    for table in PRIMARY_KEY:
        count = (await seeded.execute(text(f"SELECT count(*) FROM ai_sql.{table}"))).scalar_one()
        assert count == 0, table


async def test_the_query_role_can_read_nothing_but_the_views(seeded: AsyncConnection) -> None:
    await seeded.execute(text("SET LOCAL ROLE ai_sql_ro"))
    for statement in (
        "SELECT count(*) FROM biz.students",
        "SELECT count(*) FROM ai.documents",
        "SELECT count(*) FROM ai.audit_log",
        "SELECT count(*) FROM public.alembic_version",
    ):
        with pytest.raises(ProgrammingError, match="permission denied"):
            async with seeded.begin_nested():
                await seeded.execute(text(statement))


async def test_a_query_cannot_rewrite_its_own_identity(
    seeded: AsyncConnection, make_identity: Callable[..., Identity]
) -> None:
    student = next(a for a in accounts() if a["role"] == "student")
    identity = identity_of(student, make_identity)
    with pytest.raises(ProgrammingError, match="permission denied for function set_config"):
        async with seeded.begin_nested():
            await run_as_identity(
                seeded,
                identity,
                "SELECT set_config('app.roles', 'hr', true), count(*) FROM ai_sql.employees",
            )
    # Still a student: no employees are visible.
    rows = await run_as_identity(seeded, identity, "SELECT count(*) AS n FROM ai_sql.employees")
    assert rows[0]["n"] == 0


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT 1; SELECT 2",
        "SELECT 1; SET app.roles = 'hr'",
        "SET app.roles = 'hr'",
        "DELETE FROM ai_sql.students",
        "UPDATE ai_sql.students SET name = 'x'",
        "",
    ],
)
async def test_only_a_single_select_is_run(
    seeded: AsyncConnection, make_identity: Callable[..., Identity], sql: str
) -> None:
    identity = identity_of(accounts()[0], make_identity)
    with pytest.raises(ValueError):
        await run_as_identity(seeded, identity, sql)


async def test_the_role_is_restored_after_a_query(
    seeded: AsyncConnection, make_identity: Callable[..., Identity]
) -> None:
    before = (await seeded.execute(text("SELECT current_user"))).scalar_one()
    await run_as_identity(seeded, identity_of(accounts()[0], make_identity), "SELECT 1")
    assert (await seeded.execute(text("SELECT current_user"))).scalar_one() == before


async def test_the_row_limit_is_applied(
    seeded: AsyncConnection, make_identity: Callable[..., Identity]
) -> None:
    hr = next(a for a in accounts() if a["role"] == "hr")
    rows = await run_as_identity(
        seeded,
        identity_of(hr, make_identity),
        "SELECT employee_id FROM ai_sql.employees",
        max_rows=5,
    )
    assert len(rows) == 5


# --- evaluation questions that the views can answer -------------------------------------------

EVAL_SQL = {
    "SQL-34": "SELECT final_score FROM ai_sql.submissions WHERE assignment_id = 'TY-A01'",
    "SQL-35": "SELECT count(*) FROM ai_sql.assignments WHERE program = 'python'",
    "SQL-36": "SELECT status FROM ai_sql.expense_claims WHERE claim_id = 'C0107'",
    "SQL-37": "SELECT string_agg(claim_id, ', ' ORDER BY claim_id) FROM ai_sql.expense_claims "
              "WHERE employee_id = 'E0014' AND status = 'paid'",
    "SQL-38": "SELECT count(*) FROM ai_sql.students WHERE status = 'active' AND program = 'typescript'",
    "SQL-39": "SELECT count(*) FROM ai_sql.submissions WHERE student_id = 'S0018' AND hours_late > 0",
    "SQL-03": "SELECT count(*) FROM ai_sql.expense_claims WHERE submitted_date - expense_date > 30",
    "SQL-07": "SELECT sum(amount_cny) FROM ai_sql.expense_claims WHERE campus_id = 'BJ' AND status = 'paid'",
    "SQL-11": "SELECT format('students: %s, staff: %s', count(*) FILTER (WHERE requester_type = 'student'), "
              "count(*) FILTER (WHERE requester_type = 'staff')) FROM ai_sql.support_tickets",
    "SQL-12": "SELECT count(*) FROM ai_sql.submissions WHERE hours_late > 0",
    "SQL-14": "SELECT count(*) FROM ai_sql.employees WHERE department = 'Academic' "
              "AND level LIKE 'I%' AND campus_id = 'SZ'",
    "SQL-15": "SELECT count(*) FROM ai_sql.employees",
    "SQL-16": "SELECT count(*) FROM ai_sql.students WHERE status = 'active' AND program = 'java'",
    "SQL-17": "SELECT count(*) FROM ai_sql.support_tickets WHERE first_response_minutes > "
              "CASE priority WHEN 'P1' THEN 30 WHEN 'P2' THEN 240 ELSE 1440 END",
    "SQL-18": "SELECT count(*) FROM ai_sql.submissions WHERE hours_late > 0",
    "SQL-19": "SELECT count(*) FROM ai_sql.students WHERE status = 'active' AND program = 'python'",
    "SQL-20": "SELECT format('students: %s, staff: %s', count(*) FILTER (WHERE requester_type = 'student'), "
              "count(*) FILTER (WHERE requester_type = 'staff')) FROM ai_sql.support_tickets",
    "SQL-21": "SELECT format('%s claims, CNY %s', count(*), coalesce(sum(amount_cny), 0)) FROM ai_sql.expense_claims",
    "SQL-22": "SELECT count(*) FROM ai_sql.employees",
    "SQL-23": "SELECT count(*) FROM ai_sql.employees",
    "SQL-24": "SELECT sum(amount_cny) FROM ai_sql.expense_claims WHERE status = 'paid'",
    "SQL-25": "SELECT count(*) FROM ai_sql.submissions",
    "SQL-26": "SELECT round(avg(final_score), 1) FROM ai_sql.submissions",
}  # fmt: skip

# Questions the asker must be refused: the data they ask about is simply not visible to them.
EVAL_NOT_VISIBLE = {
    "SQL-27": "SELECT count(*) FROM ai_sql.employees WHERE campus_id = 'BJ'",
    "SQL-28": "SELECT count(*) FROM ai_sql.expense_claims WHERE campus_id = 'BJ'",
    "SQL-29": "SELECT count(*) FROM ai_sql.students WHERE campus_id = 'BJ'",
    "SQL-30": "SELECT count(*) FROM ai_sql.expense_claims",
    "SQL-31": "SELECT count(*) FROM ai_sql.employees",
    "SQL-32": "SELECT count(*) FROM ai_sql.employees",
    "SQL-33": "SELECT count(*) FROM ai_sql.students",
    "SQL-40": "SELECT count(*) FROM ai_sql.expense_claims WHERE claim_id = 'C0001'",
    "SQL-41": "SELECT count(*) FROM ai_sql.expense_claims WHERE claim_id = 'C0001'",
}


def eval_questions() -> dict[str, dict[str, object]]:
    with open(SAMPLE_DATA / "eval" / "sql-qa.jsonl", encoding="utf-8") as f:
        return {q["id"]: q for q in map(json.loads, f)}


async def test_evaluation_answers_can_be_computed_from_the_views(
    seeded: AsyncConnection, make_identity: Callable[..., Identity]
) -> None:
    by_name = {a["username"]: a for a in accounts()}
    questions = eval_questions()
    for question_id, sql in EVAL_SQL.items():
        question = questions[question_id]
        identity = identity_of(by_name[str(question["asker"])], make_identity)
        rows = await run_as_identity(seeded, identity, sql)
        value = next(iter(rows[0].values()))
        assert str(value) == question["expected_answer"], (question_id, question["question"])


async def test_refused_evaluation_questions_see_no_data(
    seeded: AsyncConnection, make_identity: Callable[..., Identity]
) -> None:
    by_name = {a["username"]: a for a in accounts()}
    questions = eval_questions()
    assert {q for q, v in questions.items() if not v["should_answer"]} == set(EVAL_NOT_VISIBLE)
    for question_id, sql in EVAL_NOT_VISIBLE.items():
        identity = identity_of(by_name[str(questions[question_id]["asker"])], make_identity)
        rows = await run_as_identity(seeded, identity, sql)
        assert next(iter(rows[0].values())) == 0, question_id
