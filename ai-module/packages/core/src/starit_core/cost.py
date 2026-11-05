"""文件：cost.py
作用：计算每次模型调用的费用，并维护全栈共用的“每日预算”。
主要思想：
  - 价格来自 LiteLLM 自带价目表（与网关同一份），所以被备用链换掉的模型会按“实际作答的模型”计价。
    表里没有的模型故意按高价计（输入 1 美元/百万 token，输出 5 美元/百万），
    宁可高估也不能让预算被突破。
  - 预算是 Redis 里“每个 UTC 日一个数字”，api、worker、mcp-server 每次调用后累加；
    在聊天请求或入库任务即将开始时检查。所以已开始的运行可以跑完，最多超出一次运行的费用（不到一分钱）。
"""

import logging
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Protocol

from starit_core.config import Settings

logger = logging.getLogger("starit.cost")

# 未知模型的保守单价（美元/百万 token）：(输入, 输出)
UNKNOWN_PRICE_PER_MILLION = (1.0, 5.0)  # USD, (input, output)


def call_cost_usd(model: str, input_tokens: int, output_tokens: int = 0) -> float:
    """一次模型调用的费用（美元）。

    参数：model 模型名；input_tokens 输入 token 数；output_tokens 输出 token 数。
    返回：费用；价目表没有该模型时按保守单价估算并记警告。
    """
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
    """时间戳对应的 UTC 日期字符串，用作预算的键。"""
    return datetime.fromtimestamp(now, UTC).strftime("%Y-%m-%d")


def seconds_until_utc_midnight(now: float) -> int:
    """距离下一个 UTC 零点（预算重置）还有几秒；429 响应的 Retry-After 用它。"""
    return int(86_400 - (now % 86_400)) + 1


class DailyBudget(Protocol):
    """每日预算的接口：limit_usd 上限、spent 已用、add 累加、exhausted 是否用完。"""

    limit_usd: float

    async def spent(self) -> float: ...

    async def add(self, usd: float) -> None: ...

    async def exhausted(self) -> bool: ...


class RedisDailyBudget:
    """用 Redis 实现的每日预算。Redis 连不上时不强制预算（只记警告）：
    丢了计数器不应让助手停摆，与限流器的选择一致。
    """

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
                # 在一个事务里累加并续期，键保留两天，过期自动清理
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
    """内存实现，用于测试和单进程场景。"""

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
    """按配置创建预算；STARIT_DAILY_BUDGET_USD 设为 0 表示关闭，返回 None。"""
    if settings.daily_budget_usd <= 0:
        return None
    return RedisDailyBudget(settings.redis_url, settings.daily_budget_usd)
