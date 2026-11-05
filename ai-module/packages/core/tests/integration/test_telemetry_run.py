"""文件：测试——一次助手运行记录了什么
测什么：一次运行是一条以运行为根的链路；运行及其模型用量被计数；令牌和问题文字不会被记录；
失败的运行会标记根 span；数据库语句成为 span 但不带参数值。
"""

from collections.abc import Callable, Iterator
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine
from starit_core.auth import Identity
from starit_core.testing import (
    Harness,
    InMemoryTelemetry,
    ScriptedChat,
    StubRetrieval,
    candidate,
    generate_json,
    retrieval_result,
    understand_json,
)

pytestmark = pytest.mark.integration

TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1In0.a-bearer-token-that-must-never-be-recorded"
QUESTION = "How long is a job offer valid for the unusual candidate?"


@pytest.fixture
def tele() -> Iterator[InMemoryTelemetry]:
    memory = InMemoryTelemetry().install()
    yield memory
    memory.restore()


@pytest.fixture
def harness(
    engines: tuple[AsyncEngine, AsyncEngine], make_identity: Callable[..., Identity]
) -> Harness:
    identity = make_identity(
        {"staff"}, user_id="ning.adm.bj", campus_id="BJ", level="S2", employee_id="E0014"
    )
    return Harness(engines[0], engines[1], identity)


async def answered_run(harness: Harness) -> Any:
    chat = ScriptedChat(
        understand=understand_json("doc_qa", "job offer valid"),
        generate=generate_json("An offer is valid for 7 calendar days [1].", citations=[1]),
    )
    retrieval = StubRetrieval(retrieval_result([candidate()], top_score=10.0))
    runtime = await harness.runtime(chat, retrieval)
    return await runtime.run(
        harness.identity, await harness.conversation(), QUESTION, access_token=TOKEN
    )


async def test_a_run_is_one_trace_with_the_run_at_its_root(
    harness: Harness, tele: InMemoryTelemetry
) -> None:
    result = await answered_run(harness)
    spans = tele.spans()
    (root,) = tele.spans("agent.run")
    assert root.parent is None
    assert dict(root.attributes)["run_id"] == str(result.run_id)
    assert dict(root.attributes)["agent.end_state"] == "answered"
    assert {s.context.trace_id for s in spans} == {root.context.trace_id}

    nodes = {s.name for s in spans}
    assert {
        "agent.load_context", "agent.guard_input", "agent.understand", "agent.retrieve_docs",
        "agent.grade_retrieval", "agent.generate", "agent.verify_answer",
    } <= nodes  # fmt: skip
    by_id = {s.context.span_id: s for s in spans}
    for node in (s for s in spans if s.name.startswith("agent.") and s.name != "agent.run"):
        assert node.parent is not None and by_id[node.parent.span_id].name == "agent.run"
    model_calls = tele.spans("llm.chat")
    assert len(model_calls) == 2  # understand and generate
    for call in model_calls:
        assert by_id[call.parent.span_id].name in ("agent.understand", "agent.generate")


async def test_a_run_counts_itself_and_its_model_use(
    harness: Harness, tele: InMemoryTelemetry
) -> None:
    await answered_run(harness)
    assert tele.metric_total("starit.runs", end_state="answered") == 1
    assert tele.metric_total("starit.llm.calls") == 2
    assert tele.metric_total("starit.llm.tokens", direction="input") == 200
    assert tele.metric_points("starit.agent.node.duration")


async def test_the_token_and_the_question_text_are_never_recorded(
    harness: Harness, tele: InMemoryTelemetry
) -> None:
    await answered_run(harness)
    recorded = tele.everything_recorded()
    assert TOKEN not in recorded and "payload" not in recorded
    assert "unusual candidate" not in recorded
    assert "job offer valid" not in recorded


async def test_a_failing_run_marks_the_root_span(harness: Harness, tele: InMemoryTelemetry) -> None:
    chat = ScriptedChat(understand=RuntimeError("model gateway down"))
    runtime = await harness.runtime(chat, StubRetrieval(retrieval_result([candidate()])))
    result = await runtime.run(harness.identity, await harness.conversation(), "anything")
    assert result.end_state == "error"
    (root,) = tele.spans("agent.run")
    assert root.status.status_code.name == "ERROR"
    assert tele.metric_total("starit.runs", end_state="error") == 1


async def test_database_statements_become_spans_without_their_values(
    engines: tuple[AsyncEngine, AsyncEngine], tele: InMemoryTelemetry
) -> None:
    from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from starit_core.telemetry import instrument_engine

    url = engines[1].url
    engine = create_async_engine(url)
    try:
        instrument_engine(engine)
        async with engine.connect() as conn:
            await conn.execute(text("SELECT :needle AS x"), {"needle": "a-value-that-is-private"})
    finally:
        SQLAlchemyInstrumentor().uninstrument()
        await engine.dispose()
    statements = [
        dict(s.attributes).get("db.statement", "")
        for s in tele.spans()
        if dict(s.attributes).get("db.system") == "postgresql"
    ]
    assert any("SELECT" in statement for statement in statements), tele.everything_recorded()
    assert "a-value-that-is-private" not in tele.everything_recorded()
