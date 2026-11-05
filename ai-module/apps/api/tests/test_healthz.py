"""文件：测试——健康检查与请求 ID
测什么：数据库正常时 /healthz 返回 ok，数据库故障时返回 503 degraded；
请求 ID 没给就生成、给了就原样回写到响应头。
"""

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from starit_api import main


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    async def database_up(_engine: object) -> bool:
        return True

    monkeypatch.setattr(main, "check_database", database_up)
    with TestClient(main.create_app()) as test_client:
        yield test_client


def test_healthz_ok(client: TestClient) -> None:
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "checks": {"database": "ok"}}


def test_healthz_reports_database_failure(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def database_down(_engine: object) -> bool:
        return False

    monkeypatch.setattr(main, "check_database", database_down)
    response = client.get("/healthz")
    assert response.status_code == 503
    assert response.json()["checks"]["database"] == "failed"


def test_request_id_is_generated_and_echoed(client: TestClient) -> None:
    generated = client.get("/healthz").headers["X-Request-Id"]
    assert len(generated) == 32
    echoed = client.get("/healthz", headers={"X-Request-Id": "abc"}).headers["X-Request-Id"]
    assert echoed == "abc"
