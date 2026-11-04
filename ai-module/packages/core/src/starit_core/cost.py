"""What a model call cost, and the daily budget the whole stack shares.

Prices come from LiteLLM's own table (the same one the gateway uses), so a model that is renamed
by a fallback is priced as the model that actually answered. A model the table does not know is
priced high on purpose (USD 1 per million input tokens, 5 per million output): an unknown price
must not let the budget run over.

The budget is one number per UTC day in Redis, added to after every model call by api, worker
and mcp-server. It is checked when a chat request or an ingestion job is about to start, so a run
that began under the limit can finish and overshoot by one run's cost (a fraction of a cent).
"""

import logging
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Protocol

from starit_core.config import Settings

logger = logging.getLogger("starit.cost")

UNKNOWN_PRICE_PER_MILLION = (1.0, 5.0)  # USD, (input, output)


def call_cost_usd(model: str, input_tokens: int, output_tokens: int = 0) -> float:
    import litellm  # imported here: it is slow to import

    try:
        prompt_cost, completion_cost = litellm.cost_per_token(
            model=model, prompt_tokens=input_tokens, completion_tokens=output_tokens
        )
    except Exception:
        price_in, price_out = UNKNOWN_PRICE_PER_MILLION
        logger.warning("no price for model %r; counting it at the unknown-model rate", model)
        return (input_tokens * price_in + output_tokens * price_out) / 1_000_000
    return float(prompt_cost + completion_cost)


def _day(now: float) -> str:
    return datetime.fromtimestamp(now, UTC).strftime("%Y-%m-%d")


def seconds_until_utc_midnight(now: float) -> int:
    return int(86_400 - (now % 86_400)) + 1


class DailyBudget(Protocol):
    limit_usd: float

    async def spent(self) -> float: ...

    async def add(self, usd: float) -> None: ...

    async def exhausted(self) -> bool: ...


class RedisDailyBudget:
    """If Redis cannot be reached the budget is not enforced (a warning is logged): losing the
    counter must not take the assistant down, the same choice as the rate limiter."""

    def __init__(self, url: str, limit_usd: float, clock: Callable[[], float] = time.time) -> None:
        import redis.asyncio as redis

        self._client = redis.from_url(url)
        self.limit_usd = limit_usd
        self._clock = clock

    def _key(self) -> str:
        return f"budget:{_day(self._clock())}"

    async def spent(self) -> float:
        try:
            value = await self._client.get(self._key())
        except Exception as exc:
            logger.warning("budget counter unavailable (%s)", exc)
            return 0.0
        return float(value) if value is not None else 0.0

    async def add(self, usd: float) -> None:
        try:
            async with self._client.pipeline(transaction=True) as pipe:
                pipe.incrbyfloat(self._key(), usd)
                pipe.expire(self._key(), 2 * 86_400)
                await pipe.execute()
        except Exception as exc:
            logger.warning("budget counter unavailable (%s); not recording %.6f USD", exc, usd)

    async def exhausted(self) -> bool:
        return await self.spent() >= self.limit_usd

    async def close(self) -> None:
        await self._client.aclose()


class InMemoryDailyBudget:
    """For tests and single-process use."""

    def __init__(self, limit_usd: float, clock: Callable[[], float] = time.time) -> None:
        self.limit_usd = limit_usd
        self._clock = clock
        self._spent: dict[str, float] = {}

    async def spent(self) -> float:
        return self._spent.get(_day(self._clock()), 0.0)

    async def add(self, usd: float) -> None:
        day = _day(self._clock())
        self._spent[day] = self._spent.get(day, 0.0) + usd

    async def exhausted(self) -> bool:
        return await self.spent() >= self.limit_usd


def make_budget(settings: Settings) -> DailyBudget | None:
    """The shared daily budget, or None when it is switched off (STARIT_DAILY_BUDGET_USD=0)."""
    if settings.daily_budget_usd <= 0:
        return None
    return RedisDailyBudget(settings.redis_url, settings.daily_budget_usd)
