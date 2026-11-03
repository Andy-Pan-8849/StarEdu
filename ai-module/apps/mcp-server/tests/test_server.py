"""A real MCP server (uvicorn in a thread) with real signature checks, against seeded data."""

import socket
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx2
import jwt
import pytest
import uvicorn
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy import create_engine
from starit_core.auth import Identity, TokenVerifier
from starit_core.config import Settings
from starit_core.dataaccess.client import McpDataTools
from starit_core.seed_biz import load_biz
from starit_mcp_server.main import build_app

pytestmark = pytest.mark.integration

SAMPLE_DATA = Path(__file__).resolve().parents[3] / "sample-data"
ISSUER = "http://localhost:8080/realms/starit"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def token(
    *,
    key: rsa.RSAPrivateKey = KEY,
    aud: list[str] | None = None,
    exp_in: int = 300,
    roles: tuple[str, ...] = ("manager",),
    campus: str = "SH",
) -> str:
    claims: dict[str, Any] = {
        "sub": "peng.mgr.sh",
        "iss": ISSUER,
        "aud": aud or ["starit-api", "starit-mcp"],
        "exp": int(time.time()) + exp_in,
        "realm_access": {"roles": list(roles)},
        "campus_id": campus,
        "employee_id": "E0018",
    }
    return jwt.encode(claims, key, algorithm="RS256")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.fixture(scope="module")
def server(scratch_urls: tuple[str, str]) -> Iterator[str]:
    owner_url, app_url = scratch_urls
    sync = create_engine(owner_url.replace("+asyncpg", "+psycopg"))
    with sync.begin() as conn:
        load_biz(conn, SAMPLE_DATA / "structured")
    sync.dispose()

    port = free_port()
    url = f"http://127.0.0.1:{port}/mcp"
    settings = Settings(
        _env_file=None,
        database_url=app_url,
        embedding_provider="fake",
        mcp_url=url,
        mcp_allowed_hosts=f"127.0.0.1:{port},mcp-server:8100",
        oidc_issuer=ISSUER,
    )
    from starit_core.db import create_engine as app_engine

    verifier = TokenVerifier(
        issuer=ISSUER, audience="starit-mcp", key_resolver=lambda _t: KEY.public_key()
    )
    config = uvicorn.Config(
        build_app(settings, app_engine(settings), verifier),
        host="127.0.0.1",
        port=port,
        log_level="error",
    )
    instance = uvicorn.Server(config)
    thread = threading.Thread(target=instance.run, daemon=True)
    thread.start()
    for _ in range(100):
        if instance.started:
            break
        time.sleep(0.05)
    else:
        pytest.fail("the server did not start")
    yield url
    instance.should_exit = True
    thread.join(timeout=5)


def whoever() -> Identity:
    return Identity("x", None, None, frozenset(), None, None)


async def test_a_valid_token_gets_the_callers_own_scope(server: str) -> None:
    tools = McpDataTools(server, lambda _i: token())
    out = await tools.call(whoever(), "list_students", {"limit": 100})
    assert out["ok"] and {s["campus_id"] for s in out["students"]} == {"SH"}


async def test_the_server_decides_who_is_asking_from_the_token(server: str) -> None:
    student = token(roles=("student",))
    out = await McpDataTools(server, lambda _i: student).call(
        whoever(), "list_my_expense_claims", {}
    )
    assert out["ok"] is False and out["error"]["code"] == "forbidden"


async def test_arguments_cannot_name_another_identity(server: str) -> None:
    out = await McpDataTools(server, lambda _i: token()).call(
        whoever(), "list_students", {"campus_id": "CD"}
    )
    assert out["ok"] is False and out["error"]["code"] == "forbidden"


@pytest.mark.parametrize(
    "bad",
    [
        None,
        "garbage",
        token(key=OTHER_KEY),
        token(exp_in=-60),
        token(aud=["starit-api"]),
    ],
    ids=["none", "garbage", "wrong-key", "expired", "wrong-audience"],
)
def test_a_bad_token_is_refused_at_the_door(server: str, bad: str | None) -> None:
    headers = {"Authorization": f"Bearer {bad}"} if bad else {}
    reply = httpx2.post(
        server,
        headers={**headers, "Accept": "application/json, text/event-stream"},
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
    )
    assert reply.status_code == 401


async def test_a_refused_call_through_the_client_is_an_error_not_data(server: str) -> None:
    out = await McpDataTools(server, lambda _i: "garbage").call(whoever(), "list_students", {})
    assert out["ok"] is False


async def test_no_token_means_no_call(server: str) -> None:
    out = await McpDataTools(server, lambda _i: None).call(whoever(), "list_students", {})
    assert out["error"]["code"] == "forbidden"


def test_health_needs_no_token(server: str) -> None:
    assert httpx2.get(server.replace("/mcp", "/health")).json() == {"status": "ok"}


def _initialize(server: str, host: str) -> httpx2.Response:
    return httpx2.post(
        server,
        headers={
            "Host": host,
            "Authorization": f"Bearer {token()}",
            "Accept": "application/json, text/event-stream",
        },
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "t", "version": "0"},
            },
        },
    )


def test_the_compose_service_name_is_an_accepted_host(server: str) -> None:
    """Regression: the API reaches the server as mcp-server:8100, which the SDK's host check
    refused until the allowed hosts were configured. A valid token, so only the host decides."""
    assert _initialize(server, "mcp-server:8100").status_code == 200


def test_an_unknown_host_is_refused_even_with_a_valid_token(server: str) -> None:
    assert _initialize(server, "evil.example").status_code in (400, 421)
