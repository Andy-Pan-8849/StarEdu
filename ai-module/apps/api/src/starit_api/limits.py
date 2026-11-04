"""The three limits on the chat endpoint: the user, the address, and the day's spend.

Each refuses with HTTP 429 and a `Retry-After`, before any model is called; a refused request
costs nothing. The address is the connection's own address unless it comes from a trusted proxy
(`STARIT_TRUSTED_PROXIES`), in which case the nearest `X-Forwarded-For` hop that is not itself a
trusted proxy is used. A forged header from anyone else is ignored.
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

MESSAGES = {
    "user": "Too many messages; wait a minute",
    "ip": "Too many requests from this address; wait a minute",
    "budget": "The assistant's daily budget is used up; it resets at 00:00 UTC",
}


def parse_networks(value: str) -> list[Network]:
    return [
        ipaddress.ip_network(part.strip(), strict=False)
        for part in value.split(",")
        if part.strip()
    ]


def client_ip(request: Request, trusted: list[Network]) -> str:
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
    """Raises the 429 for the first limit that is hit."""
    ip = client_ip(request, parse_networks(settings.trusted_proxies))
    if not await limiter.allow(f"chatip:{ip}", settings.rate_limit_ip_per_minute, 60):
        raise refuse("ip", 60)
    if not await limiter.allow(f"chat:{user_id}", settings.rate_limit_chat_per_minute, 60):
        raise refuse("user", 60)
    if budget is not None and await budget.exhausted():
        raise refuse("budget", seconds_until_utc_midnight(now))
