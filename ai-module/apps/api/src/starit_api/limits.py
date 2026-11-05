"""文件：limits.py
作用：聊天接口的三道限制：每用户、每 IP、全栈当日花费。
主要思想：任何一道触发都返回 HTTP 429 和 Retry-After，
  并且发生在调用模型之前——被拒绝的请求不花钱。
IP 取连接的真实地址；只有请求来自受信任的代理(STARIT_TRUSTED_PROXIES)时，才采信
  X-Forwarded-For，
并取“离我们最近的、本身不是受信任代理”的那一跳。其他人伪造的这个头一律忽略。
"""

import ipaddress
from typing import Literal

from fastapi import Request
from starit_core import telemetry
from starit_core.config import Settings
from starit_core.cost import DailyBudget, seconds_until_utc_midnight
from starit_core.ratelimit import RateLimiter

from starit_api.errors import ApiError

type Network = ipaddress.IPv4Network | ipaddress.IPv6Network

# 三种限制对应的提示（预算用完时说明几点重置）
MESSAGES = {
    "user": "Too many messages; wait a minute",
    "ip": "Too many requests from this address; wait a minute",
    "budget": "The assistant's daily budget is used up; it resets at 00:00 UTC",
}


def parse_networks(value: str) -> list[Network]:
    """把逗号分隔的网段配置解析成网络对象列表。"""
    return [
        ipaddress.ip_network(part.strip(), strict=False)
        for part in value.split(",")
        if part.strip()
    ]


def client_ip(request: Request, trusted: list[Network]) -> str:
    """判断这个请求的客户端 IP。

    不用代理：就是连接地址。有受信任代理且连接来自它：从 X-Forwarded-For 链从右往左，
    找第一个不属于受信任代理的地址；链里有无法解析的地址就退回连接地址。
    """
    peer = request.client.host if request.client else "unknown"
    if not trusted:
        return peer
    try:
        peer_address = ipaddress.ip_address(peer)
    except ValueError:
        return peer
    if not any(peer_address in network for network in trusted):
        return peer  # not a proxy we trust: its X-Forwarded-For is just a header anyone can send
    hops = [h.strip() for h in request.headers.get("x-forwarded-for", "").split(",") if h.strip()]
    for hop in reversed(hops):
        try:
            address = ipaddress.ip_address(hop)
        except ValueError:
            return peer
        if not any(address in network for network in trusted):
            return str(address)
    return peer


def refuse(dimension: Literal["user", "ip", "budget"], retry_after: int) -> ApiError:
    """构造 429 错误并记一次限流指标；Retry-After 至少 1 秒。"""
    telemetry.current().rate_limited.add(1, {"dimension": dimension})
    return ApiError(
        429, "rate_limited", MESSAGES[dimension], {"Retry-After": str(max(1, retry_after))}
    )


async def check_chat_limits(
    request: Request,
    settings: Settings,
    limiter: RateLimiter,
    budget: DailyBudget | None,
    user_id: str,
    now: float,
) -> None:
    """依次检查三道限制，触发哪道就抛对应的 429：
      1. IP 每分钟次数；2. 用户每分钟次数；3. 当日总预算（重置时间为下个 UTC 零点）。
    参数：request 请求；settings 配置；limiter 限流器；budget 预算（可为 None）；user_id 用户；
      now 当前时间戳。
    """
    ip = client_ip(request, parse_networks(settings.trusted_proxies))
    if not await limiter.allow(f"chatip:{ip}", settings.rate_limit_ip_per_minute, 60):
        raise refuse("ip", 60)
    if not await limiter.allow(f"chat:{user_id}", settings.rate_limit_chat_per_minute, 60):
        raise refuse("user", 60)
    if budget is not None and await budget.exhausted():
        raise refuse("budget", seconds_until_utc_midnight(now))
