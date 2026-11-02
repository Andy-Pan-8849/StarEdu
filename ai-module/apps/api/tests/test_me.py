import time
from collections.abc import Iterator
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends
from fastapi.testclient import TestClient
from starit_api import main
from starit_api.deps import get_verifier, require_roles
from starit_core.auth import AuthUnavailableError, TokenVerifier

ISSUER = "http://localhost:8080/realms/starit"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def token(roles: list[str], **overrides: Any) -> str:
    payload: dict[str, Any] = {
        "sub": "user-1",
        "iss": ISSUER,
        "aud": ["starit-api"],
        "exp": int(time.time()) + 300,
        "preferred_username": "hr.bj",
        "name": "HR Beijing",
        "realm_access": {"roles": roles},
        "campus_id": "BJ",
        "level": "M2",
    }
    payload.update(overrides)
    return jwt.encode(payload, KEY, algorithm="RS256")


@pytest.fixture
def client() -> Iterator[TestClient]:
    app = main.create_app()
    verifier = TokenVerifier(
        issuer=ISSUER, audience="starit-api", key_resolver=lambda _t: KEY.public_key()
    )
    app.dependency_overrides[get_verifier] = lambda: verifier

    @app.get("/_hr_only", dependencies=[Depends(require_roles("hr", "finance"))])
    async def hr_only() -> dict[str, str]:
        return {"ok": "yes"}

    with TestClient(app) as test_client:
        yield test_client


def auth(value: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {value}"}


def test_me_returns_identity_from_token(client: TestClient) -> None:
    response = client.get("/me", headers=auth(token(["hr", "offline_access"])))
    assert response.status_code == 200
    assert response.json() == {
        "user_id": "user-1",
        "name": "HR Beijing",
        "roles": ["hr"],
        "campus_id": "BJ",
        "level": "M2",
    }


def test_missing_token_is_401_with_unified_error(client: TestClient) -> None:
    response = client.get("/me", headers={"X-Request-Id": "req-9"})
    assert response.status_code == 401
    assert response.headers["WWW-Authenticate"] == "Bearer"
    assert response.json() == {
        "error": {
            "code": "unauthenticated",
            "message": "Missing bearer token",
            "request_id": "req-9",
        }
    }


@pytest.mark.parametrize(
    "bad",
    [
        "garbage",
        jwt.encode({"sub": "x"}, "secret", algorithm="HS256"),
    ],
)
def test_invalid_token_is_401(client: TestClient, bad: str) -> None:
    response = client.get("/me", headers=auth(bad))
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"


def test_expired_token_is_401(client: TestClient) -> None:
    expired = token(["hr"], exp=int(time.time()) - 5)
    assert client.get("/me", headers=auth(expired)).status_code == 401


def test_wrong_audience_is_401(client: TestClient) -> None:
    other = token(["hr"], aud=["starit-mcp"])
    assert client.get("/me", headers=auth(other)).status_code == 401


def test_role_gate_allows_and_denies(client: TestClient) -> None:
    allowed = client.get("/_hr_only", headers=auth(token(["finance"])))
    assert allowed.status_code == 200
    denied = client.get("/_hr_only", headers=auth(token(["staff"])))
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "forbidden"
    no_role = client.get("/_hr_only", headers=auth(token([])))
    assert no_role.status_code == 403


def test_identity_service_outage_is_503_not_401() -> None:
    def unreachable(_token: str) -> Any:
        raise AuthUnavailableError("keys unavailable")

    app = main.create_app()
    verifier = TokenVerifier(issuer=ISSUER, audience="starit-api", key_resolver=unreachable)
    app.dependency_overrides[get_verifier] = lambda: verifier
    with TestClient(app) as test_client:
        response = test_client.get("/me", headers=auth("a.b.c"))
    assert response.status_code == 503


def test_healthz_stays_public(client: TestClient) -> None:
    assert client.get("/healthz").status_code in (200, 503)
