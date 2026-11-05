"""文件：测试——助手的数据路径（集成）
测什么：固定工具与模型生成 SQL 两条路；工具参数错误退回 SQL；SQL
  被校验器拒绝/数据库拒绝后带反馈重写；
无权限与查不到的结局；引用里记录用到的视图和行数。
"""

import csv
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import create_engine as create_sync_engine
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from starit_core.agent import messages
from starit_core.auth import Identity
from starit_core.config import Settings
from starit_core.dataaccess.tools import DataTools
from starit_core.seed_biz import load_biz
from starit_core.testing import (
    Harness,
    ScriptedChat,
    StubRetrieval,
    answer_data_json,
    candidate,
    plan_json,
    retrieval_result,
    sql_json,
    understand_json,
)

pytestmark = pytest.mark.integration

SAMPLE_DATA = Path(__file__).resolve().parents[4] / "sample-data"
with open(SAMPLE_DATA / "demo-accounts.csv", newline="", encoding="utf-8") as _f:
    ACCOUNTS = {a["username"]: a for a in csv.DictReader(_f)}
TOKEN = "header.payload.signature-of-the-callers-jwt"


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
def seeded_urls(scratch_urls: tuple[str, str]) -> tuple[str, str]:
    owner_url, _ = scratch_urls
    engine = create_sync_engine(owner_url.replace("+asyncpg", "+psycopg"))
    with engine.begin() as conn:
        load_biz(conn, SAMPLE_DATA / "structured")
    engine.dispose()
    return scratch_urls


@pytest.fixture
async def engines_(seeded_urls: tuple[str, str]) -> AsyncIterator[tuple[AsyncEngine, AsyncEngine]]:
    owner, app = create_async_engine(seeded_urls[0]), create_async_engine(seeded_urls[1])
    yield owner, app
    await owner.dispose()
    await app.dispose()


class SpyTools:
    """Wraps DataTools and records the token it is given."""

    def __init__(self, inner: DataTools) -> None:
        self.inner = inner
        self.tokens: list[str | None] = []

    async def call(
        self,
        identity: Identity,
        name: str,
        arguments: dict[str, Any],
        *,
        token: str | None = None,
    ) -> dict[str, Any]:
        self.tokens.append(token)
        return await self.inner.call(identity, name, arguments)


def harness_for(engines_: tuple[AsyncEngine, AsyncEngine], username: str) -> Harness:
    return Harness(engines_[0], engines_[1], person(username))


def tools_for(engines_: tuple[AsyncEngine, AsyncEngine]) -> SpyTools:
    return SpyTools(DataTools(engines_[1], Settings(_env_file=None, embedding_provider="fake")))


POLICY = retrieval_result(
    [candidate("FIN-REIM-002", "Hotel limit in tier 1 cities is CNY 600 per night.")]
)


async def ask(harness: Harness, chat: ScriptedChat, text: str = "how many?", **kw: Any) -> Any:
    runtime = await harness.runtime(chat, StubRetrieval(POLICY), **kw)
    return await runtime.run(
        harness.identity, await harness.conversation(), text, access_token=TOKEN
    )


async def test_a_tool_call_answers_from_the_callers_own_scope(
    engines_: tuple[AsyncEngine, AsyncEngine],
) -> None:
    harness, tools = harness_for(engines_, "peng.mgr.sh"), tools_for(engines_)
    chat = ScriptedChat(
        understand=understand_json("data_query", "list my campus students"),
        plan=plan_json("tool", "list_students", limit=100),
        answer_data=answer_data_json("There are some java students [1]."),
    )
    result = await ask(harness, chat, data_tools=tools)
    assert (result.end_state, result.end_reason) == ("answered", None)
    assert chat.steps() == ["understand", "plan", "answer_data"]
    assert result.citations[0]["kind"] == "data"
    assert result.citations[0]["views"] == ["students"]
    shown = chat.prompts("answer_data")[0]
    assert '"campus_id": "SH"' in shown and '"campus_id": "BJ"' not in shown
    assert tools.tokens == [TOKEN]


async def test_the_token_is_never_recorded(engines_: tuple[AsyncEngine, AsyncEngine]) -> None:
    harness, tools = harness_for(engines_, "peng.mgr.sh"), tools_for(engines_)
    chat = ScriptedChat(
        understand=understand_json("data_query"),
        plan=plan_json("tool", "list_assignments"),
        answer_data=answer_data_json(),
    )
    await ask(harness, chat, data_tools=tools)
    stored = await harness.rows(
        "SELECT (SELECT string_agg(details::text, '') FROM ai.audit_log), "
        "(SELECT string_agg(content, '') FROM ai.messages)"
    )
    assert TOKEN not in str(stored)
    assert all(TOKEN not in p for _, m in chat.calls for p in [str(m)])


async def test_a_tool_that_finds_nothing_ends_not_found(
    engines_: tuple[AsyncEngine, AsyncEngine],
) -> None:
    harness = harness_for(engines_, "peng.mgr.sh")
    chat = ScriptedChat(
        understand=understand_json("data_query"),
        plan=plan_json("tool", "get_student_progress", student_id="S9999"),
    )
    result = await ask(harness, chat, data_tools=tools_for(engines_))
    assert (result.end_state, result.end_reason) == ("not_found", "no_matching_rows")
    assert result.content == messages.NO_MATCHING_ROWS


async def test_a_tool_the_role_cannot_use_ends_no_permission_in_the_same_words(
    engines_: tuple[AsyncEngine, AsyncEngine],
) -> None:
    harness = harness_for(engines_, "wei.stu.sh")
    chat = ScriptedChat(
        understand=understand_json("data_query"),
        plan=plan_json("tool", "list_my_expense_claims"),
    )
    result = await ask(harness, chat, data_tools=tools_for(engines_))
    assert (result.end_state, result.end_reason) == ("no_permission", "restricted_data")
    assert result.content == messages.NO_MATCHING_ROWS
    assert "answer_data" not in chat.steps()


async def test_sql_is_written_with_the_schema_and_policy_then_run(
    engines_: tuple[AsyncEngine, AsyncEngine],
) -> None:
    harness = harness_for(engines_, "peng.mgr.sh")
    chat = ScriptedChat(
        understand=understand_json("data_query", "how many students"),
        plan=plan_json("sql"),
        sql=sql_json("select count(*) as n from ai_sql.students -- comment"),
        answer_data=answer_data_json("There are N students [1]."),
    )
    result = await ask(harness, chat)
    assert (result.end_state, result.end_reason) == ("answered", None)
    prompt = chat.prompts("sql")[0]
    assert "ai_sql.students" in prompt and "campus_id: SH" in prompt
    assert "CNY 600 per night" in prompt
    assert result.citations[0] == {"n": 1, "kind": "data", "views": ["students"], "row_count": 1}
    assert '"n": ' in chat.prompts("answer_data")[0]


async def test_a_rejected_statement_is_retried_with_the_reason(
    engines_: tuple[AsyncEngine, AsyncEngine],
) -> None:
    harness = harness_for(engines_, "peng.mgr.sh")
    chat = ScriptedChat(
        understand=understand_json("data_query"),
        plan=plan_json("sql"),
        sql=[sql_json("DELETE FROM ai_sql.students"), sql_json()],
        answer_data=answer_data_json(),
    )
    result = await ask(harness, chat)
    assert result.end_state == "answered"
    assert chat.steps().count("sql") == 2
    assert "Only a SELECT" in chat.prompts("sql")[1]


async def test_a_database_error_is_retried_then_given_up(
    engines_: tuple[AsyncEngine, AsyncEngine],
) -> None:
    harness = harness_for(engines_, "peng.mgr.sh")
    chat = ScriptedChat(
        understand=understand_json("data_query"),
        plan=plan_json("sql"),
        sql=sql_json("SELECT nonexistent FROM ai_sql.students"),
    )
    result = await ask(harness, chat)
    assert (result.end_state, result.end_reason) == ("error", "sql_failed")
    assert chat.steps().count("sql") == 3  # the first try and two retries
    assert "answer_data" not in chat.steps()


@pytest.mark.parametrize(
    ("username", "sql"),
    [
        ("wei.stu.sh", "SELECT * FROM ai_sql.employees"),
        ("tao.admin.bj", "SELECT * FROM ai_sql.students"),
        ("peng.mgr.sh", "SELECT * FROM ai_sql.students WHERE campus_id = 'BJ'"),
    ],
)
async def test_out_of_scope_sql_is_refused_before_it_runs(
    engines_: tuple[AsyncEngine, AsyncEngine], username: str, sql: str
) -> None:
    harness = harness_for(engines_, username)
    chat = ScriptedChat(
        understand=understand_json("data_query"), plan=plan_json("sql"), sql=sql_json(sql)
    )
    result = await ask(harness, chat)
    assert (result.end_state, result.end_reason) == ("no_permission", "restricted_data")
    assert result.content == messages.NO_MATCHING_ROWS
    assert chat.steps().count("sql") == 1 and "answer_data" not in chat.steps()


async def test_no_rows_ends_not_found(engines_: tuple[AsyncEngine, AsyncEngine]) -> None:
    harness = harness_for(engines_, "peng.mgr.sh")
    chat = ScriptedChat(
        understand=understand_json("data_query"),
        plan=plan_json("sql"),
        sql=sql_json("SELECT * FROM ai_sql.students WHERE name = 'Nobody At All'"),
    )
    result = await ask(harness, chat)
    assert (result.end_state, result.end_reason) == ("not_found", "no_matching_rows")


@pytest.mark.parametrize("plan", ["not json", plan_json("tool", "drop_everything")])
async def test_an_unusable_plan_falls_back_to_sql(
    engines_: tuple[AsyncEngine, AsyncEngine], plan: str
) -> None:
    harness = harness_for(engines_, "peng.mgr.sh")
    chat = ScriptedChat(
        understand=understand_json("data_query"),
        plan=plan,
        sql=sql_json(),
        answer_data=answer_data_json(),
    )
    assert (await ask(harness, chat, data_tools=tools_for(engines_))).end_state == "answered"


async def test_an_answer_without_a_marker_gets_one(
    engines_: tuple[AsyncEngine, AsyncEngine],
) -> None:
    harness = harness_for(engines_, "peng.mgr.sh")
    chat = ScriptedChat(
        understand=understand_json("data_query"),
        plan=plan_json("sql"),
        sql=sql_json(),
        answer_data=answer_data_json("Plain answer."),
    )
    assert (await ask(harness, chat)).content == "Plain answer. [1]"


async def test_the_run_is_audited_with_its_data_path(
    engines_: tuple[AsyncEngine, AsyncEngine],
) -> None:
    harness = harness_for(engines_, "peng.mgr.sh")
    chat = ScriptedChat(
        understand=understand_json("data_query"),
        plan=plan_json("sql"),
        sql=sql_json(),
        answer_data=answer_data_json(),
    )
    await ask(harness, chat)
    rows = await harness.rows(
        "SELECT details->>'end_state', details->'prompt_versions'->>'sql' "
        "FROM ai.audit_log WHERE action = 'chat.query' ORDER BY id DESC LIMIT 1"
    )
    assert rows == [("answered", "1")]
