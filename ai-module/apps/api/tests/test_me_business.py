"""文件：测试——业务模式下的 /me
测什么：装配了业务身份解析器时，接口的身份来自解析器（业务模块的回答），不是令牌声明；
业务模块拒绝是 401、不可用是 503；没有装配时沿用原来的行为。
"""

import uuid
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from starit_api import main
from starit_core.auth import AuthError, AuthUnavailableError, BusinessAccess, Identity

ID = Identity(
    user_id="kc-1",
    username="teacher.one",
    name="Teacher One",
    roles=frozenset({"staff", "manager"}),
    campus_id="BJ",
    level=None,
    business=BusinessAccess(
        tenant_id=str(uuid.uuid4()),
        tenant_code="hq",
        account_id=str(uuid.uuid4()),
        person_id=None,
        kind="staff",
        permissions=frozenset(),
        scopes_json="{}",
        perm_version=1,
    ),
)


class Fake:
    def __init__(self, outcome: Identity | Exception) -> None:
        self.outcome = outcome
        self.tokens: list[str] = []

    async def resolve(self, token: str) -> Identity:
        self.tokens.append(token)
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(main.create_app()) as test_client:
        yield test_client


def test_the_identity_comes_from_the_business_resolver(client: TestClient) -> None:
    fake = Fake(ID)
    client.app.state.business_resolver = fake  # type: ignore[attr-defined]
    response = client.get("/me", headers={"Authorization": "Bearer abc.def.ghi"})
    assert response.status_code == 200
    assert response.json()["roles"] == ["manager", "staff"]
    assert response.json()["campus_id"] == "BJ"
    assert fake.tokens == ["abc.def.ghi"]


def test_a_refusal_is_401_and_an_outage_is_503(client: TestClient) -> None:
    client.app.state.business_resolver = Fake(AuthError("no"))  # type: ignore[attr-defined]
    assert client.get("/me", headers={"Authorization": "Bearer x"}).status_code == 401
    client.app.state.business_resolver = Fake(AuthUnavailableError("down"))  # type: ignore[attr-defined]
    assert client.get("/me", headers={"Authorization": "Bearer x"}).status_code == 503


def test_without_a_token_it_is_401_before_the_business_module_is_asked(client: TestClient) -> None:
    fake = Fake(ID)
    client.app.state.business_resolver = fake  # type: ignore[attr-defined]
    assert client.get("/me").status_code == 401
    assert fake.tokens == []
