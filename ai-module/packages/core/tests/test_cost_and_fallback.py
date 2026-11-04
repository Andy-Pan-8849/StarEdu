"""Prices, the daily budget, the fallback chain, and which model gets the credit."""

import socket
from types import SimpleNamespace
from typing import Any

import litellm
import pytest
from starit_core import telemetry
from starit_core.agent.nodes import BudgetedChat, _same_model
from starit_core.agent.state import RunTotals
from starit_core.config import Settings
from starit_core.cost import (
    InMemoryDailyBudget,
    RedisDailyBudget,
    call_cost_usd,
    make_budget,
    seconds_until_utc_midnight,
)
from starit_core.llm import LiteLLMChatClient, chat_client, parse_fallbacks
from starit_core.testing import InMemoryTelemetry, ScriptedChat, understand_json


def test_known_models_are_priced_from_litellms_table() -> None:
    assert call_cost_usd("openai/gpt-6-luna", 1000, 100) == pytest.approx(1e-4 + 5e-5)
    assert call_cost_usd("gpt-4o-mini-2024-07-18", 1000, 100) == pytest.approx(1.5e-4 + 6e-5)
    assert call_cost_usd("anthropic/claude-haiku-5-5", 1000, 100) == pytest.approx(1e-4 + 5e-5)
    assert call_cost_usd("openai/text-embedding-3-small", 1000) == pytest.approx(2e-5)


def test_an_unknown_model_is_priced_high_so_the_budget_cannot_run_over() -> None:
    unknown = call_cost_usd("openai/gpt-nobody-has-heard-of", 1_000_000, 1_000_000)
    assert unknown == pytest.approx(6.0)


async def test_the_budget_adds_up_per_day_and_resets_at_midnight_utc() -> None:
    now = [1_793_800_000.0]  # some moment on a UTC day
    budget = InMemoryDailyBudget(0.5, clock=lambda: now[0])
    assert not await budget.exhausted()
    await budget.add(0.3)
    await budget.add(0.2)
    assert await budget.spent() == pytest.approx(0.5) and await budget.exhausted()
    now[0] += 86_400  # the next day
    assert await budget.spent() == 0.0 and not await budget.exhausted()


def test_seconds_until_reset_points_at_utc_midnight() -> None:
    assert seconds_until_utc_midnight(86_400 * 5 + 86_400 - 10) == 11
    assert seconds_until_utc_midnight(86_400 * 5) == 86_401


def test_the_budget_can_be_switched_off() -> None:
    assert make_budget(Settings(_env_file=None, daily_budget_usd=0)) is None
    assert make_budget(Settings(_env_file=None, daily_budget_usd=0.5)) is not None


def redis_reachable() -> bool:
    try:
        with socket.create_connection(("localhost", 6379), timeout=0.5):
            return True
    except OSError:
        return False


@pytest.mark.skipif(not redis_reachable(), reason="Redis is not reachable")
async def test_the_redis_budget_counts_in_one_shared_key() -> None:
    now = [1_793_900_000.0]
    budget = RedisDailyBudget("redis://localhost:6379/15", 0.5, clock=lambda: now[0])
    other = RedisDailyBudget("redis://localhost:6379/15", 0.5, clock=lambda: now[0])
    try:
        await budget._client.delete(budget._key())
        await budget.add(0.25)
        await other.add(0.25)  # a second process adds to the same day
        assert await budget.spent() == pytest.approx(0.5) and await budget.exhausted()
    finally:
        await budget._client.delete(budget._key())
        await budget.close()
        await other.close()


async def test_a_budget_that_cannot_reach_redis_does_not_stop_the_assistant() -> None:
    budget = RedisDailyBudget("redis://127.0.0.1:1/0", 0.5)
    assert await budget.spent() == 0.0 and not await budget.exhausted()
    await budget.add(0.1)  # logged, not raised
    await budget.close()


# --- the fallback chain ---------------------------------------------------------------------


@pytest.fixture
def seen(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    async def fake(**kwargs: Any) -> Any:
        calls.append(kwargs)
        message = SimpleNamespace(content="ok")
        usage = SimpleNamespace(prompt_tokens=10, completion_tokens=2)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=message)], usage=usage, model="gpt-4o-mini-2024-07-18"
        )

    monkeypatch.setattr(litellm, "acompletion", fake)
    return calls


def test_the_fallback_list_is_read_from_the_setting() -> None:
    assert parse_fallbacks("openai/gpt-4o-mini, anthropic/claude-haiku-5-5 ,") == [
        "openai/gpt-4o-mini",
        "anthropic/claude-haiku-5-5",
    ]
    assert parse_fallbacks("") == []


async def test_direct_calls_pass_the_fallbacks_as_given(seen: list[dict[str, Any]]) -> None:
    client = LiteLLMChatClient(fallbacks=["openai/gpt-4o-mini", "anthropic/claude-haiku-5-5"])
    result = await client.complete([{"role": "user", "content": "hi"}], model="openai/gpt-6-luna")
    assert seen[0]["fallbacks"] == ["openai/gpt-4o-mini", "anthropic/claude-haiku-5-5"]
    assert result.model == "gpt-4o-mini-2024-07-18"  # the model that answered is reported


async def test_gateway_calls_prefix_each_fallback_like_the_model(
    seen: list[dict[str, Any]],
) -> None:
    client = LiteLLMChatClient(
        "http://g:4000", "k", ["openai/gpt-4o-mini", "anthropic/claude-haiku-5-5"]
    )
    await client.complete([{"role": "user", "content": "hi"}], model="openai/gpt-6-luna")
    assert seen[0]["model"] == "openai/openai/gpt-6-luna"
    assert seen[0]["fallbacks"] == [
        "openai/openai/gpt-4o-mini",
        "openai/anthropic/claude-haiku-5-5",
    ]


async def test_no_fallbacks_means_the_parameter_is_not_sent(seen: list[dict[str, Any]]) -> None:
    await LiteLLMChatClient().complete(
        [{"role": "user", "content": "hi"}], model="openai/gpt-6-luna"
    )
    assert "fallbacks" not in seen[0]


def test_settings_build_the_chain_into_the_client() -> None:
    settings = Settings(_env_file=None, llm_fallbacks="openai/gpt-4o-mini")
    assert chat_client(settings)._fallbacks == ["openai/gpt-4o-mini"]  # type: ignore[attr-defined]


# --- crediting the model that answered ---------------------------------------------------------


@pytest.mark.parametrize(
    ("answered", "requested", "same"),
    [
        ("gpt-4o-mini-2024-07-18", "openai/gpt-4o-mini", True),
        ("gpt-6-luna", "openai/gpt-6-luna", True),
        ("openai/gpt-6-luna", "openai/gpt-6-luna", True),
        ("gpt-4o-mini-2024-07-18", "openai/gpt-6-luna", False),
        ("claude-haiku-5-5-20261001", "openai/gpt-6-luna", False),
    ],
)
def test_a_dated_name_is_still_the_same_model(answered: str, requested: str, same: bool) -> None:
    assert _same_model(answered, requested) is same


class AnsweredBy:
    """A chat client that says another model answered."""

    def __init__(self, model: str) -> None:
        self.model = model

    async def complete(self, *_a: Any, **kw: Any) -> Any:
        return SimpleNamespace(text="x", input_tokens=1000, output_tokens=100, model=self.model)


async def test_a_fallback_is_priced_and_counted_as_the_model_that_answered() -> None:
    tele = InMemoryTelemetry().install()
    budget = InMemoryDailyBudget(0.5)
    totals = RunTotals()
    try:
        chat = BudgetedChat(AnsweredBy("gpt-4o-mini-2024-07-18"), totals, 10, 5.0, budget)
        await chat.complete([{"role": "user", "content": "q"}], model="openai/gpt-6-luna")
    finally:
        tele.restore()
    assert totals.fallbacks == 1
    assert totals.cost_usd == pytest.approx(1.5e-4 + 6e-5)  # gpt-4o-mini's price, not luna's
    assert await budget.spent() == pytest.approx(totals.cost_usd)
    (call,) = tele.spans("llm.chat")
    attrs = dict(call.attributes)
    assert (
        attrs["llm.fallback"] is True and attrs["gen_ai.response.model"] == "gpt-4o-mini-2024-07-18"
    )
    assert tele.metric_total("starit.llm.fallbacks") == 1
    assert tele.metric_total("starit.llm.cost_usd") == pytest.approx(totals.cost_usd)


async def test_the_requested_model_answering_is_not_a_fallback() -> None:
    tele = InMemoryTelemetry().install()
    totals = RunTotals()
    try:
        chat = BudgetedChat(AnsweredBy("gpt-6-luna"), totals, 10, 5.0)
        await chat.complete([{"role": "user", "content": "q"}], model="openai/gpt-6-luna")
    finally:
        tele.restore()
    assert totals.fallbacks == 0 and tele.metric_total("starit.llm.fallbacks") == 0
    assert "llm.fallback" not in dict(tele.spans("llm.chat")[0].attributes)


async def test_a_client_that_does_not_report_a_model_is_priced_as_requested() -> None:
    totals = RunTotals()
    chat = BudgetedChat(ScriptedChat(understand=understand_json()), totals, 10, 5.0)
    await chat.complete(
        [{"role": "system", "content": "intake step"}, {"role": "user", "content": "q"}],
        model="openai/gpt-6-luna",
    )
    assert totals.fallbacks == 0 and totals.cost_usd == pytest.approx(100 * 1e-7 + 20 * 5e-7)
    assert telemetry.current() is not None
