import json
import logging
from collections.abc import Iterator

import pytest
from opentelemetry.trace import StatusCode
from starit_core import telemetry
from starit_core.agent.nodes import BudgetedChat
from starit_core.agent.state import RunTotals
from starit_core.config import Settings
from starit_core.llm import ChatError
from starit_core.logging import JsonFormatter, run_id_var
from starit_core.testing import InMemoryTelemetry, ScriptedChat, understand_json

SECRET = "eyJhbGciOiJSUzI1NiJ9.payload.signature-of-a-bearer-token"


@pytest.fixture
def tele() -> Iterator[InMemoryTelemetry]:
    memory = InMemoryTelemetry().install()
    yield memory
    memory.restore()


async def chat_once(inner: ScriptedChat, tele: InMemoryTelemetry) -> None:
    chat = BudgetedChat(inner, RunTotals(), 10, 5.0)
    await chat.complete(
        [
            {"role": "system", "content": "intake step"},
            {"role": "user", "content": "what is the secret question?"},
        ],
        model="openai/gpt-6-luna",
    )


async def test_a_model_call_is_a_span_and_counts_tokens(tele: InMemoryTelemetry) -> None:
    await chat_once(ScriptedChat(understand=understand_json()), tele)
    (call,) = tele.spans("llm.chat")
    attrs = dict(call.attributes)
    assert attrs["gen_ai.request.model"] == "openai/gpt-6-luna"
    assert attrs["gen_ai.usage.input_tokens"] == 100 and attrs["gen_ai.usage.output_tokens"] == 20
    assert attrs["langfuse.observation.type"] == "generation"
    assert tele.metric_total("starit.llm.calls", outcome="ok") == 1
    assert tele.metric_total("starit.llm.tokens", direction="input") == 100
    assert tele.metric_total("starit.llm.tokens", direction="output") == 20


async def test_a_failing_model_call_marks_the_span_and_counts_the_error(
    tele: InMemoryTelemetry,
) -> None:
    with pytest.raises(ChatError):
        await chat_once(ScriptedChat(understand=ChatError("provider down")), tele)
    (call,) = tele.spans("llm.chat")
    assert call.status.status_code is StatusCode.ERROR
    assert tele.metric_total("starit.llm.calls", outcome="error") == 1


async def test_prompts_and_answers_stay_out_of_spans_unless_asked_for() -> None:
    quiet = InMemoryTelemetry().install()
    try:
        await chat_once(ScriptedChat(understand=understand_json()), quiet)
        assert "secret question" not in quiet.everything_recorded()
        assert "langfuse.observation.input" not in quiet.spans("llm.chat")[0].attributes
    finally:
        quiet.restore()
    loud = InMemoryTelemetry(capture_content=True).install()
    try:
        await chat_once(ScriptedChat(understand=understand_json()), loud)
        attrs = loud.spans("llm.chat")[0].attributes
        assert "secret question" in attrs["langfuse.observation.input"]
        assert len(attrs["langfuse.observation.input"]) <= telemetry.CONTENT_LIMIT
    finally:
        loud.restore()


def test_logs_carry_the_trace_and_run_ids_inside_a_span(tele: InMemoryTelemetry) -> None:
    record = logging.LogRecord("t", logging.INFO, __file__, 1, "hello", (), None)
    assert "trace_id" not in json.loads(JsonFormatter().format(record))
    token = run_id_var.set("run-42")
    try:
        with telemetry.span("work") as active:
            data = json.loads(JsonFormatter().format(record))
            expected = f"{active.get_span_context().trace_id:032x}"
    finally:
        run_id_var.reset(token)
    assert data["trace_id"] == expected and data["run_id"] == "run-42"


def test_an_exception_in_a_span_marks_it_as_an_error(tele: InMemoryTelemetry) -> None:
    with pytest.raises(RuntimeError), telemetry.span("boom"):
        raise RuntimeError("x")
    assert tele.spans("boom")[0].status.status_code is StatusCode.ERROR


def test_nothing_is_set_up_unless_enabled() -> None:
    assert telemetry.setup_telemetry(Settings(_env_file=None), "starit-test") is None


def test_enabled_settings_build_exporting_providers_and_the_content_switch() -> None:
    previous = telemetry.current()
    settings = Settings(
        _env_file=None,
        otel_enabled=True,
        otel_endpoint="http://127.0.0.1:9",
        otel_capture_content=True,
    )
    try:
        providers = telemetry.setup_telemetry(settings, "starit-test")
        assert providers is not None
        assert telemetry.current().capture_content is True
        providers.tracer_provider.shutdown()
        providers.meter_provider.shutdown()
    finally:
        telemetry.use(previous)


def test_the_queue_length_is_reported_as_a_gauge(tele: InMemoryTelemetry) -> None:
    tele.telemetry.set_queue_length(7)
    assert [p.value for p in tele.metric_points("starit.ingest.queue_length")] == [7]
