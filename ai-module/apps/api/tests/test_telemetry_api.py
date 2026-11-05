"""文件：测试——API 的链路
测什么：每个请求一个 HTTP span；健康检查不产生 span；任何 span 里都不出现 Bearer 令牌。
"""

import time
from collections.abc import Iterator

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from starit_api import main
from starit_api.deps import get_verifier
from starit_core.auth import TokenVerifier
from starit_core.telemetry import Providers
from starit_core.testing import InMemoryTelemetry

ISSUER = "http://localhost:8080/realms/starit"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture
def traced() -> Iterator[tuple[TestClient, InMemoryTelemetry, str]]:
    tele = InMemoryTelemetry().install()
    app = main.create_app(Providers(tele.tracer_provider, tele.meter_provider))
    verifier = TokenVerifier(
        issuer=ISSUER, audience="starit-api", key_resolver=lambda _t: KEY.public_key()
    )
    app.dependency_overrides[get_verifier] = lambda: verifier
    payload = {
        "sub": "u1", "iss": ISSUER, "aud": ["starit-api"], "exp": int(time.time()) + 300,
        "realm_access": {"roles": ["staff"]}, "campus_id": "BJ",
    }  # fmt: skip
    token = jwt.encode(payload, KEY, algorithm="RS256")
    with TestClient(app) as client:
        yield client, tele, token
    tele.restore()


def test_a_request_is_a_span_and_the_token_is_not_in_it(
    traced: tuple[TestClient, InMemoryTelemetry, str],
) -> None:
    client, tele, token = traced
    assert client.get("/me", headers={"Authorization": f"Bearer {token}"}).status_code == 200
    recorded = tele.everything_recorded()
    assert "GET /me" in recorded
    assert token not in recorded and "Bearer" not in recorded
    assert any(p for p in tele.metric_points("http.server.duration"))


def test_health_checks_do_not_fill_the_traces(
    traced: tuple[TestClient, InMemoryTelemetry, str],
) -> None:
    client, tele, _ = traced
    client.get("/healthz")
    assert not [s for s in tele.spans() if "healthz" in s.name]


def test_without_providers_nothing_is_instrumented() -> None:
    app = main.create_app()
    assert not getattr(app, "_is_instrumented_by_opentelemetry", False)
