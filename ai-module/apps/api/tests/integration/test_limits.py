"""文件：测试——聊天接口的三道限制（集成）
测什么：IP、用户、当日花费三道限制各自触发 429 和 Retry-After；被拒绝的请求不调用模型；
X-Forwarded-For 只在来自受信任代理时才被采信，别人伪造的会被忽略。
"""

import time
from collections.abc import Callable, Iterator
from typing import Any

import jwt
import psycopg
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import create_async_engine
from starit_api import main
from starit_api.deps import get_budget, get_limiter, get_runtime, get_verifier
from starit_api.limits import client_ip, parse_networks
from starit_core.agent.runtime import AgentRuntime
from starit_core.auth import TokenVerifier
from starit_core.config import Settings, get_settings
from starit_core.cost import InMemoryDailyBudget
from starit_core.embeddings import FakeEmbeddingClient
from starit_core.ratelimit import InMemoryRateLimiter
from starit_core.testing import InMemoryTelemetry, ScriptedChat, StubRetrieval, understand_json

pytestmark = pytest.mark.integration

ISSUER = "http://localhost:8080/realms/starit"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def headers(user: str) -> dict[str, str]:
    payload = {
        "sub": user, "iss": ISSUER, "aud": ["starit-api"], "exp": int(time.time()) + 300,
        "realm_access": {"roles": ["staff"]}, "campus_id": "BJ", "level": "S2", "employee_id": "E1",
    }  # fmt: skip
    return {"Authorization": "Bearer " + jwt.encode(payload, KEY, algorithm="RS256")}


class Env:
    def __init__(self, client: TestClient, budget: InMemoryDailyBudget, chat: ScriptedChat) -> None:
        self.client, self.budget, self.chat = client, budget, chat

    def conversation(self, who: dict[str, str], ip: str | None = None) -> str:
        r = self.client.post("/conversations", headers=who)
        return str(r.json()["id"])

    def say(self, cid: str, who: dict[str, str], ip: str | None = None) -> Any:
        extra = {"X-Forwarded-For": ip} if ip else {}
        return self.client.post(
            f"/conversations/{cid}/messages", json={"content": "hello"}, headers={**who, **extra}
        )


@pytest.fixture
def make_env(
    scratch_urls: tuple[str, str], monkeypatch: pytest.MonkeyPatch
) -> Iterator[Callable[..., Env]]:
    opened: list[Any] = []

    def build(**settings_env: str) -> Env:
        with psycopg.connect(scratch_urls[0].replace("+psycopg", ""), autocommit=True) as owner:
            owner.execute("TRUNCATE ai.conversations CASCADE")
        monkeypatch.setenv("STARIT_DATABASE_URL", scratch_urls[1])
        for name, value in settings_env.items():
            monkeypatch.setenv(name, value)
        get_settings.cache_clear()
        chat = ScriptedChat(understand=understand_json("chitchat", "hello"))
        runtime = AgentRuntime(
            engine=create_async_engine(scratch_urls[1]),
            settings=Settings(_env_file=None, embedding_provider="fake"),
            embedder=FakeEmbeddingClient(),
            chat=chat,
            retrieve_fn=StubRetrieval(),
        )
        verifier = TokenVerifier(
            issuer=ISSUER, audience="starit-api", key_resolver=lambda _t: KEY.public_key()
        )
        app = main.create_app()
        budget = InMemoryDailyBudget(0.5)
        limiter = InMemoryRateLimiter()
        app.dependency_overrides[get_verifier] = lambda: verifier
        app.dependency_overrides[get_runtime] = lambda: runtime
        app.dependency_overrides[get_limiter] = lambda: limiter
        app.dependency_overrides[get_budget] = lambda: budget
        client = TestClient(app)
        client.__enter__()
        opened.append(client)
        return Env(client, budget, chat)

    yield build
    for client in opened:
        client.__exit__(None, None, None)
    get_settings.cache_clear()


def test_the_user_limit_is_a_429_with_retry_after(make_env: Callable[..., Env]) -> None:
    env = make_env(STARIT_RATE_LIMIT_CHAT_PER_MINUTE="2", STARIT_RATE_LIMIT_IP_PER_MINUTE="100")
    alice = headers("alice")
    cid = env.conversation(alice)
    assert env.say(cid, alice).status_code == 200 and env.say(cid, alice).status_code == 200
    refused = env.say(cid, alice)
    assert refused.status_code == 429 and refused.headers["retry-after"] == "60"
    assert refused.json()["error"]["code"] == "rate_limited"
    assert "Too many messages" in refused.json()["error"]["message"]
    # Someone else is not affected by Alice's limit.
    bob = headers("bob")
    assert env.say(env.conversation(bob), bob).status_code == 200


def test_the_address_limit_stops_many_users_behind_one_address(
    make_env: Callable[..., Env],
) -> None:
    env = make_env(STARIT_RATE_LIMIT_CHAT_PER_MINUTE="50", STARIT_RATE_LIMIT_IP_PER_MINUTE="3")
    statuses = []
    for n in range(5):
        who = headers(f"user{n}")
        statuses.append(env.say(env.conversation(who), who).status_code)
    assert statuses == [200, 200, 200, 429, 429]
    last = env.say(env.conversation(headers("user9")), headers("user9"))
    assert "this address" in last.json()["error"]["message"]


def test_a_forged_forwarded_header_does_not_dodge_the_address_limit(
    make_env: Callable[..., Env],
) -> None:
    env = make_env(STARIT_RATE_LIMIT_CHAT_PER_MINUTE="50", STARIT_RATE_LIMIT_IP_PER_MINUTE="2")
    codes = []
    for n in range(4):  # no trusted proxy is configured, so the header is only a header
        who = headers(f"user{n}")
        codes.append(env.say(env.conversation(who), who, ip=f"203.0.113.{n}").status_code)
    assert codes == [200, 200, 429, 429]


def test_a_spent_budget_refuses_new_questions_before_any_model_call(
    make_env: Callable[..., Env],
) -> None:
    env = make_env()
    who = headers("alice")
    cid = env.conversation(who)
    assert env.say(cid, who).status_code == 200
    calls_before = len(env.chat.calls)
    import asyncio

    asyncio.run(env.budget.add(0.5))
    refused = env.say(cid, who)
    assert refused.status_code == 429 and "daily budget" in refused.json()["error"]["message"]
    assert 1 <= int(refused.headers["retry-after"]) <= 86_401
    assert len(env.chat.calls) == calls_before  # nothing was spent on the refused request


def test_each_refusal_is_counted_by_dimension(make_env: Callable[..., Env]) -> None:
    tele = InMemoryTelemetry().install()
    try:
        env = make_env(STARIT_RATE_LIMIT_CHAT_PER_MINUTE="1", STARIT_RATE_LIMIT_IP_PER_MINUTE="100")
        who = headers("alice")
        cid = env.conversation(who)
        env.say(cid, who)
        env.say(cid, who)
        assert tele.metric_total("starit.rate_limited", dimension="user") == 1
    finally:
        tele.restore()


# --- which address a request comes from ----------------------------------------------------------


class FakeRequest:
    def __init__(self, peer: str | None, forwarded: str | None = None) -> None:
        self.client = None if peer is None else type("C", (), {"host": peer})()
        self.headers = {"x-forwarded-for": forwarded} if forwarded else {}


@pytest.mark.parametrize(
    ("trusted", "peer", "forwarded", "expected"),
    [
        ("", "10.0.0.7", "198.51.100.9", "10.0.0.7"),  # no trusted proxy: the connection itself
        ("10.0.0.0/8", "10.0.0.7", "198.51.100.9", "198.51.100.9"),
        ("10.0.0.0/8", "10.0.0.7", "198.51.100.9, 10.1.1.1", "198.51.100.9"),  # proxies chained
        ("10.0.0.0/8", "10.0.0.7", "6.6.6.6, 198.51.100.9", "198.51.100.9"),  # forged left part
        ("10.0.0.0/8", "198.51.100.9", "6.6.6.6", "198.51.100.9"),  # peer is not a proxy
        ("10.0.0.0/8", "10.0.0.7", None, "10.0.0.7"),  # no header
        ("10.0.0.0/8", "10.0.0.7", "not-an-address", "10.0.0.7"),
        ("10.0.0.0/8,192.168.0.0/16", "192.168.1.5", "203.0.113.4", "203.0.113.4"),
        ("10.0.0.0/8", "2001:db8::1", "1.2.3.4", "2001:db8::1"),
    ],
)
def test_the_address_is_taken_from_the_nearest_untrusted_hop(
    trusted: str, peer: str, forwarded: str | None, expected: str
) -> None:
    request: Any = FakeRequest(peer, forwarded)
    assert client_ip(request, parse_networks(trusted)) == expected


def test_a_request_without_a_peer_address_still_has_a_key() -> None:
    request: Any = FakeRequest(None)
    assert client_ip(request, []) == "unknown"
