"""文件：测试——真实 Keycloak（集成）
测什么：对每个演示账号取真实令牌并调用 /me，身份与示例数据一致；被篡改的真实令牌会被拒绝。
前提：需要 Compose 栈里的 Keycloak（make up）；连不上时自动跳过。
"""

import csv
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from starit_api import main
from starit_core.config import get_settings

pytestmark = pytest.mark.integration

PASSWORD = "demo-pass-123"

# The demo accounts are defined once, in the sample data (a real person each).
ACCOUNTS_CSV = Path(__file__).resolve().parents[4] / "sample-data" / "demo-accounts.csv"
with open(ACCOUNTS_CSV, newline="", encoding="utf-8") as _handle:
    ACCOUNTS = {row["username"]: row for row in csv.DictReader(_handle)}


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
    account = ACCOUNTS[username]
    response = client.get("/me", headers={"Authorization": f"Bearer {fetch_token(username)}"})
    assert response.status_code == 200
    body = response.json()
    assert body["roles"] == [account["role"]]
    assert body["campus_id"] == account["campus_id"]
    assert body["level"] == (account["level"] or None)
    if account["subject_type"] == "student":
        assert body["student_id"] == account["subject_id"] and body["employee_id"] is None
    else:
        assert body["employee_id"] == account["subject_id"] and body["student_id"] is None


def test_tampered_real_token_is_rejected(client: TestClient) -> None:
    header, payload, signature = fetch_token("wei.acad.sh").split(".")
    flipped = ("A" if signature[0] != "A" else "B") + signature[1:]
    response = client.get("/me", headers={"Authorization": f"Bearer {header}.{payload}.{flipped}"})
    assert response.status_code == 401
