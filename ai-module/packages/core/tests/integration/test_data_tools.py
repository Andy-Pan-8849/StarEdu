"""文件：测试——六个数据工具（集成）
测什么：针对种子业务数据，以不同的人调用六个工具——学员只看到自己，主管看本校区，总部看全部；
越权返回 forbidden / not_found；参数校验；每次调用都写审计。
"""

import csv
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from starit_core.auth import Identity
from starit_core.config import Settings
from starit_core.dataaccess.tools import DataTools
from starit_core.seed_biz import load_biz
from starit_core.testing import StubRetrieval, candidate, retrieval_result

pytestmark = pytest.mark.integration

SAMPLE_DATA = Path(__file__).resolve().parents[4] / "sample-data"


def read_csv(path: Path) -> list[dict[str, str]]:
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


ACCOUNTS = {a["username"]: a for a in read_csv(SAMPLE_DATA / "demo-accounts.csv")}
STUDENTS = read_csv(SAMPLE_DATA / "structured" / "students.csv")
CLAIMS = read_csv(SAMPLE_DATA / "structured" / "expense_claims.csv")


def person(username: str) -> Identity:
    a = ACCOUNTS[username]
    student = a["subject_type"] == "student"
    return Identity(
        user_id=a["username"],
        username=a["username"],
        name=a["name"],
        roles=frozenset({a["role"]}),
        campus_id=a["campus_id"],
        level=a["level"] or None,
        employee_id=None if student else a["subject_id"],
        student_id=a["subject_id"] if student else None,
    )


@pytest.fixture(scope="module")
def engines(scratch_urls: tuple[str, str]) -> tuple[str, str]:
    return scratch_urls


@pytest.fixture
async def owner(engines: tuple[str, str]) -> AsyncIterator[AsyncEngine]:
    engine = create_async_engine(engines[0])
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: load_biz(c, SAMPLE_DATA / "structured"))
        await conn.execute(text("TRUNCATE ai.audit_log"))
    yield engine
    await engine.dispose()


@pytest.fixture
async def tools(engines: tuple[str, str], owner: AsyncEngine) -> AsyncIterator[DataTools]:
    app = create_async_engine(engines[1])
    yield DataTools(app, Settings(_env_file=None, embedding_provider="fake"))
    await app.dispose()


async def audited(owner: AsyncEngine) -> list[tuple[Any, ...]]:
    async with owner.connect() as conn:
        rows = await conn.execute(
            text("SELECT action, user_id, details FROM ai.audit_log ORDER BY id")
        )
        return [tuple(r) for r in rows]


def code(outcome: dict[str, Any]) -> str:
    assert outcome["ok"] is False
    return str(outcome["error"]["code"])


async def test_a_manager_lists_only_their_campus(tools: DataTools) -> None:
    out = await tools.call(person("peng.mgr.sh"), "list_students", {"limit": 100})
    assert out["ok"] and {s["campus_id"] for s in out["students"]} == {"SH"}


async def test_a_manager_naming_another_campus_is_refused_not_emptied(tools: DataTools) -> None:
    out = await tools.call(person("peng.mgr.sh"), "list_students", {"campus_id": "cd"})
    assert code(out) == "forbidden"


async def test_hr_may_name_any_campus(tools: DataTools) -> None:
    out = await tools.call(person("qing.hr.bj"), "list_students", {"campus_id": "CD"})
    assert out["ok"] and {s["campus_id"] for s in out["students"]} == {"CD"}


async def test_a_student_sees_only_themselves(tools: DataTools) -> None:
    out = await tools.call(person("wei.stu.sh"), "list_students", {})
    assert [s["student_id"] for s in out["students"]] == ["S0018"]


async def test_progress_of_a_student_in_scope(tools: DataTools) -> None:
    out = await tools.call(person("wei.stu.sh"), "get_student_progress", {"student_id": "S0018"})
    assert out["ok"] and out["student"]["student_id"] == "S0018"
    assert out["summary"]["submitted"] == len(out["submissions"])


async def test_progress_of_a_student_out_of_scope_looks_like_no_such_student(
    tools: DataTools,
) -> None:
    other = next(s["student_id"] for s in STUDENTS if s["campus_id"] == "BJ")
    out = await tools.call(person("peng.mgr.sh"), "get_student_progress", {"student_id": other})
    assert code(out) == "not_found"
    missing = await tools.call(
        person("peng.mgr.sh"), "get_student_progress", {"student_id": "S9999"}
    )
    assert out["error"] == missing["error"]


async def test_a_student_cannot_use_expense_tools(tools: DataTools) -> None:
    me = person("wei.stu.sh")
    assert code(await tools.call(me, "list_my_expense_claims", {})) == "forbidden"
    assert code(await tools.call(me, "get_expense_claim_status", {"claim_id": "C0001"})) == (
        "forbidden"
    )


async def test_admin_has_no_business_data_but_sees_assignments(tools: DataTools) -> None:
    admin = person("tao.admin.bj")
    assert code(await tools.call(admin, "list_students", {})) == "forbidden"
    assert (await tools.call(admin, "list_assignments", {"program": "java"}))["ok"]


async def test_my_claims_are_only_mine(tools: DataTools) -> None:
    me = person("wei.acad.sh")
    out = await tools.call(me, "list_my_expense_claims", {"limit": 100})
    mine = [c["claim_id"] for c in CLAIMS if c["employee_id"] == me.employee_id]
    if mine:
        assert sorted(c["claim_id"] for c in out["claims"]) == sorted(mine)
    else:
        assert code(out) == "not_found"


async def test_a_staff_member_cannot_read_a_colleagues_claim(tools: DataTools) -> None:
    me = person("wei.acad.sh")
    theirs = next(c["claim_id"] for c in CLAIMS if c["employee_id"] != me.employee_id)
    out = await tools.call(me, "get_expense_claim_status", {"claim_id": theirs})
    assert code(out) == "not_found"


async def test_a_manager_reads_a_claim_from_their_campus_only(tools: DataTools) -> None:
    me = person("peng.mgr.sh")
    here = next(c["claim_id"] for c in CLAIMS if c["campus_id"] == "SH")
    there = next(c["claim_id"] for c in CLAIMS if c["campus_id"] == "BJ")
    assert (await tools.call(me, "get_expense_claim_status", {"claim_id": here}))["ok"]
    assert code(await tools.call(me, "get_expense_claim_status", {"claim_id": there})) == (
        "not_found"
    )


@pytest.mark.parametrize(
    ("tool", "arguments"),
    [
        ("get_student_progress", {"student_id": "x'; DROP TABLE biz.students; --"}),
        ("get_student_progress", {}),
        ("get_expense_claim_status", {"claim_id": "S0001"}),
        ("list_students", {"limit": 100000}),
        ("list_students", {"campus_id": "BEIJING"}),
        ("list_students", {"program": "cobol"}),
        ("list_students", {"unexpected": 1}),
        ("list_assignments", {"due_after": "not a date"}),
        ("search_documents", {"query": ""}),
        ("search_documents", {"query": "x", "top_k": 99}),
        ("no_such_tool", {}),
    ],
)
async def test_bad_arguments_are_refused(
    tools: DataTools, tool: str, arguments: dict[str, Any]
) -> None:
    assert code(await tools.call(person("qing.hr.bj"), tool, arguments)) == "invalid_argument"


async def test_a_name_filter_is_a_literal_not_a_pattern(tools: DataTools) -> None:
    out = await tools.call(person("qing.hr.bj"), "list_students", {"name_contains": "%"})
    assert code(out) == "not_found"


async def test_every_call_is_audited_including_refusals(
    tools: DataTools, owner: AsyncEngine
) -> None:
    await tools.call(person("peng.mgr.sh"), "list_students", {})
    await tools.call(person("peng.mgr.sh"), "list_students", {"campus_id": "CD"})
    await tools.call(person("peng.mgr.sh"), "get_student_progress", {"student_id": "bad"})
    rows = await audited(owner)
    assert [r[0] for r in rows] == ["mcp.list_students"] * 2 + ["mcp.get_student_progress"]
    assert [r[2]["result"] for r in rows] == ["ok", "forbidden", "invalid_argument"]
    assert all(r[1] == "peng.mgr.sh" for r in rows)


async def test_search_documents_filters_by_domain_and_limits(
    engines: tuple[str, str], owner: AsyncEngine
) -> None:
    chunks = [
        candidate("HR-REC-001"),
        candidate("FIN-REIM-002"),
        candidate("TS-ENV-001"),
        candidate("FIN-REIM-003"),
    ]
    app = create_async_engine(engines[1])
    try:
        tools = DataTools(
            app,
            Settings(_env_file=None, embedding_provider="fake"),
            retrieve_fn=StubRetrieval(retrieval_result(chunks)),
        )
        me = person("qing.hr.bj")
        finance = await tools.call(me, "search_documents", {"query": "x", "domain": "finance"})
        assert finance["doc_codes"] == ["FIN-REIM-002", "FIN-REIM-003"]
        two = await tools.call(me, "search_documents", {"query": "x", "top_k": 2})
        assert len(two["passages"]) == 2
    finally:
        await app.dispose()
