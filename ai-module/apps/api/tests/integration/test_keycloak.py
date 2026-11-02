"""Needs the Compose stack with Keycloak (make up). Skipped when Keycloak is unreachable."""

from collections.abc import Iterator

import httpx
import pytest
from fastapi.testclient import TestClient
from starit_api import main
from starit_core.config import get_settings

pytestmark = pytest.mark.integration

PASSWORD = "demo-pass-123"

# username -> (roles, campus_id, level)
ACCOUNTS = {
    "student.sh": (["student"], "SH", None),
    "staff.bj": (["staff"], "BJ", "S2"),
    "staff.sh": (["staff"], "SH", "I2"),
    "manager.sh": (["manager"], "SH", "M3"),
    "hr.bj": (["hr"], "BJ", "M2"),
    "finance.bj": (["finance"], "BJ", "S2"),
    "admin.bj": (["Admin"], "BJ", "S2"),
    "ragetl.bj": (["RAGETLAdmin"], "BJ", "S1"),
}


def token_url() -> str:
    return get_settings().oidc_issuer + "/protocol/openid-connect/token"


def fetch_token(username: str) -> str:
    response = httpx.post(
        token_url(),
        data={
            "grant_type": "password",
            "client_id": "starit-web",
            "username": username,
            "password": PASSWORD,
        },
        timeout=10,
    )
    response.raise_for_status()
    return str(response.json()["access_token"])


@pytest.fixture(scope="module")
def client() -> Iterator[TestClient]:
    try:
        httpx.get(get_settings().oidc_jwks_url, timeout=3).raise_for_status()
    except httpx.HTTPError:
        pytest.skip("Keycloak is not reachable")
    with TestClient(main.create_app()) as test_client:
        yield test_client


@pytest.mark.parametrize("username", sorted(ACCOUNTS))
def test_me_for_every_demo_account(client: TestClient, username: str) -> None:
    roles, campus, level = ACCOUNTS[username]
    response = client.get("/me", headers={"Authorization": f"Bearer {fetch_token(username)}"})
    assert response.status_code == 200
    body = response.json()
    assert body["roles"] == roles
    assert body["campus_id"] == campus
    assert body["level"] == level


def test_tampered_real_token_is_rejected(client: TestClient) -> None:
    header, payload, signature = fetch_token("staff.sh").split(".")
    flipped = ("A" if signature[0] != "A" else "B") + signature[1:]
    response = client.get("/me", headers={"Authorization": f"Bearer {header}.{payload}.{flipped}"})
    assert response.status_code == 401
