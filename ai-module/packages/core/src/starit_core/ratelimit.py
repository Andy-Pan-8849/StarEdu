"""文件：ratelimit.py
作用：固定窗口限流器（设计见 docs/design/03 第 7 节）。
主要思想：每个“键 + 时间窗口”一个 Redis 计数器，窗口过期后自动清零；超过上限就拒绝。
固定窗口实现简单，缺点是窗口边界附近可能瞬时放行两倍，对本项目够用。
"""

import logging
import time
from collections.abc import Callable
from typing import Protocol

logger = logging.getLogger("starit.ratelimit")


class RateLimiter(Protocol):
    """限流器接口：allow(键, 上限, 窗口秒数) 返回是否放行。"""

    async def allow(self, key: str, limit: int, window_seconds: int = 60) -> bool: ...


class RedisRateLimiter:
    """用 Redis 计数。Redis 连不上就放行并记警告：限流器坏了不该让助手整个不可用。"""

    def __init__(self, url: str, clock: Callable[[], float] = time.time) -> None:
        import redis.asyncio as redis

        self._client = redis.from_url(url)
        self._clock = clock

    async def allow(self, key: str, limit: int, window_seconds: int = 60) -> bool:
        # 桶名 = 键 + 当前第几个窗口；每过一个窗口自动换新桶
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
    """内存实现，用于测试和单进程场景。"""

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._counts: dict[str, int] = {}

    async def allow(self, key: str, limit: int, window_seconds: int = 60) -> bool:
        bucket = f"{key}:{int(self._clock() // window_seconds)}"
        self._counts[bucket] = self._counts.get(bucket, 0) + 1
        return self._counts[bucket] <= limit
