"""A fixed-window request limiter (docs/design/03-api-and-mcp-contract.md, section 7)."""

import logging
import time
from collections.abc import Callable
from typing import Protocol

logger = logging.getLogger("starit.ratelimit")


class RateLimiter(Protocol):
    async def allow(self, key: str, limit: int, window_seconds: int = 60) -> bool: ...


class RedisRateLimiter:
    """Counts requests per key in a Redis counter that expires with its window.

    If Redis cannot be reached the request is allowed and a warning is logged: losing the limiter
    should not take the assistant down.
    """

    def __init__(self, url: str, clock: Callable[[], float] = time.time) -> None:
        import redis.asyncio as redis

        self._client = redis.from_url(url)
        self._clock = clock

    async def allow(self, key: str, limit: int, window_seconds: int = 60) -> bool:
        bucket = f"ratelimit:{key}:{int(self._clock() // window_seconds)}"
        try:
            async with self._client.pipeline(transaction=True) as pipe:
                pipe.incr(bucket)
                pipe.expire(bucket, window_seconds)
                count, _ = await pipe.execute()
        except Exception as exc:
            logger.warning("rate limiter unavailable (%s); allowing the request", exc)
            return True
        return int(count) <= limit

    async def close(self) -> None:
        await self._client.aclose()


class InMemoryRateLimiter:
    """For tests and single-process use."""

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._counts: dict[str, int] = {}

    async def allow(self, key: str, limit: int, window_seconds: int = 60) -> bool:
        bucket = f"{key}:{int(self._clock() // window_seconds)}"
        self._counts[bucket] = self._counts.get(bucket, 0) + 1
        return self._counts[bucket] <= limit
