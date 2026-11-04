"""The conversation endpoints on a scratch database, with a scripted assistant."""

import time
from collections.abc import Iterator
from typing import Any

import jwt
import psycopg
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import create_async_engine
from starit_api import main
from starit_api.deps import get_limiter, get_runtime, get_verifier
from starit_core.agent.runtime import AgentRuntime
from starit_core.auth import TokenVerifier
from starit_core.config import Settings, get_settings
from starit_core.embeddings import FakeEmbeddingClient
from starit_core.ratelimit import InMemoryRateLimiter
from starit_core.testing import ScriptedChat, StubRetrieval, understand_json

pytestmark = pytest.mark.integration

ISSUER = "http://localhost:8080/realms/starit"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def token(user: str) -> dict[str, str]:
    payload = {
        "sub": user, "iss": ISSUER, "aud": ["starit-api"], "exp": int(time.time()) + 300,
        "preferred_username": user, "realm_access": {"roles": ["staff"]}, "campus_id": "BJ",
        "level": "S2", "employee_id": "E0014",
    }  # fmt: skip
    return {"Authorization": "Bearer " + jwt.encode(payload, KEY, algorithm="RS256")}


ALICE, BOB = token("alice"), token("bob")


@pytest.fixture
def api(scratch_urls: tuple[str, str], monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    # The scratch database lives for the whole module; start each test with no conversations.
    with psycopg.connect(scratch_urls[0].replace("+psycopg", ""), autocommit=True) as owner:
        owner.execute("TRUNCATE ai.conversations CASCADE")
    monkeypatch.setenv("STARIT_DATABASE_URL", scratch_urls[1])
    monkeypatch.setenv("STARIT_RATE_LIMIT_CHAT_PER_MINUTE", "3")
    get_settings.cache_clear()
    settings = get_settings()
    engine = create_async_engine(scratch_urls[1])
    chat = ScriptedChat(understand=understand_json("chitchat", "hello"))
    runtime = AgentRuntime(
        engine=engine,
        settings=Settings(_env_file=None, embedding_provider="fake"),
        embedder=FakeEmbeddingClient(),
        chat=chat,
        retrieve_fn=StubRetrieval(),
    )
    verifier = TokenVerifier(
        issuer=ISSUER, audience="starit-api", key_resolver=lambda _t: KEY.public_key()
    )
    app = main.create_app()
    app.dependency_overrides[get_verifier] = lambda: verifier
    app.dependency_overrides[get_runtime] = lambda: runtime
    limiter = InMemoryRateLimiter()
    app.dependency_overrides[get_limiter] = lambda: limiter
    assert settings.rate_limit_chat_per_minute == 3
    with TestClient(app) as client:
        yield client
    get_settings.cache_clear()


def create(client: TestClient, who: dict[str, str] = ALICE) -> str:
    response = client.post("/conversations", headers=who)
    assert response.status_code == 201
    return str(response.json()["id"])


def say(client: TestClient, conversation_id: str, text: str, who: dict[str, str] = ALICE) -> Any:
    return client.post(
        f"/conversations/{conversation_id}/messages", json={"content": text}, headers=who
    )


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/conversations"),
        ("GET", "/conversations"),
        ("GET", "/conversations/00000000-0000-0000-0000-000000000001"),
        ("PATCH", "/conversations/00000000-0000-0000-0000-000000000001"),
        ("DELETE", "/conversations/00000000-0000-0000-0000-000000000001"),
        ("GET", "/conversations/00000000-0000-0000-0000-000000000001/messages"),
        ("POST", "/conversations/00000000-0000-0000-0000-000000000001/messages"),
    ],
)
def test_every_endpoint_needs_a_login(api: TestClient, method: str, path: str) -> None:
    response = api.request(method, path, json={"content": "x", "title": "x"})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"


def test_create_get_rename_and_list(api: TestClient) -> None:
    created = api.post("/conversations", headers=ALICE).json()
    assert created["title"] is None and created["archived"] is False and created["id"]
    cid = created["id"]
    assert api.get(f"/conversations/{cid}", headers=ALICE).json()["id"] == cid
    renamed = api.patch(
        f"/conversations/{cid}", json={"title": "  Leave questions  "}, headers=ALICE
    )
    assert renamed.status_code == 200 and renamed.json()["title"] == "Leave questions"
    assert [c["id"] for c in api.get("/conversations", headers=ALICE).json()["items"]] == [cid]
    assert api.patch(f"/conversations/{cid}", json={"title": ""}, headers=ALICE).status_code == 422


def test_someone_elses_conversation_does_not_exist(api: TestClient) -> None:
    cid = create(api, ALICE)
    assert api.get("/conversations", headers=BOB).json()["items"] == []
    for method, path, body in [
        ("GET", f"/conversations/{cid}", None),
        ("PATCH", f"/conversations/{cid}", {"title": "mine now"}),
        ("DELETE", f"/conversations/{cid}", None),
        ("GET", f"/conversations/{cid}/messages", None),
        ("POST", f"/conversations/{cid}/messages", {"content": "hello"}),
    ]:
        response = api.request(method, path, json=body, headers=BOB)
        assert response.status_code == 404, (method, path)
        assert response.json()["error"]["code"] == "not_found"
        assert response.json()["error"]["request_id"]
    # Alice's conversation is untouched.
    assert api.get(f"/conversations/{cid}", headers=ALICE).json()["title"] is None


def test_a_malformed_id_or_cursor_is_a_validation_error(api: TestClient) -> None:
    assert api.get("/conversations/not-a-uuid", headers=ALICE).status_code == 422
    bad = api.get("/conversations?cursor=garbage", headers=ALICE)
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "validation_error"
    assert api.get("/conversations?limit=0", headers=ALICE).status_code == 422
    assert api.get("/conversations?limit=101", headers=ALICE).status_code == 422


def test_the_list_is_paged_newest_first(api: TestClient) -> None:
    ids = [create(api) for _ in range(3)]
    first = api.get("/conversations?limit=2", headers=ALICE).json()
    assert [c["id"] for c in first["items"]] == [ids[2], ids[1]] and first["next_cursor"]
    second = api.get(f"/conversations?limit=2&cursor={first['next_cursor']}", headers=ALICE).json()
    assert [c["id"] for c in second["items"]] == [ids[0]] and second["next_cursor"] is None


def test_archiving_hides_a_conversation_and_closes_it(api: TestClient) -> None:
    cid = create(api)
    assert api.delete(f"/conversations/{cid}", headers=ALICE).status_code == 204
    assert api.get("/conversations", headers=ALICE).json()["items"] == []
    assert api.get(f"/conversations/{cid}", headers=ALICE).json()["archived"] is True
    blocked = say(api, cid, "hello again")
    assert blocked.status_code == 409 and blocked.json()["error"]["code"] == "conflict"


def test_a_message_gets_an_answer_in_the_agreed_shape_and_the_history_is_kept(
    api: TestClient,
) -> None:
    cid = create(api)
    response = say(api, cid, "  Hello!  ")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"run_id", "message", "end_state", "end_reason"}
    assert (body["end_state"], body["end_reason"]) == ("answered", None)
    assert body["message"]["role"] == "assistant" and body["message"]["citations"] == []
    assert body["message"]["content"].startswith("Hello!")

    history = api.get(f"/conversations/{cid}/messages", headers=ALICE).json()
    assert [(m["role"], m["content"][:6]) for m in history["items"]] == [
        ("user", "Hello!"),
        ("assistant", "Hello!"),
    ]
    assert (
        history["items"][1]["id"] == body["message"]["id"]
        and history["items"][1]["run_id"] == body["run_id"]
    )
    assert api.get(f"/conversations/{cid}", headers=ALICE).json()["title"] == "Hello!"

    paged = api.get(f"/conversations/{cid}/messages?limit=1", headers=ALICE).json()
    assert [m["role"] for m in paged["items"]] == ["user"] and paged["next_cursor"]
    rest = api.get(
        f"/conversations/{cid}/messages?limit=1&cursor={paged['next_cursor']}", headers=ALICE
    ).json()
    assert [m["role"] for m in rest["items"]] == ["assistant"] and rest["next_cursor"] is None


@pytest.mark.parametrize("content", ["", "   ", "x" * 4001])
def test_an_empty_or_oversized_message_is_rejected(api: TestClient, content: str) -> None:
    cid = create(api)
    response = say(api, cid, content)
    assert response.status_code == 422 and response.json()["error"]["code"] == "validation_error"
    assert api.get(f"/conversations/{cid}/messages", headers=ALICE).json()["items"] == []


def test_messages_are_limited_per_user_per_minute(api: TestClient) -> None:
    cid, bobs = create(api, ALICE), create(api, BOB)
    assert [say(api, cid, f"hi {n}").status_code for n in range(3)] == [200, 200, 200]
    limited = say(api, cid, "one too many")
    assert limited.status_code == 429
    assert (
        limited.json()["error"]["code"] == "rate_limited" and limited.headers["Retry-After"] == "60"
    )
    assert say(api, bobs, "hi", BOB).status_code == 200  # the limit is per user
    # A refused message left no trace.
    history = api.get(f"/conversations/{cid}/messages?limit=100", headers=ALICE).json()["items"]
    assert len(history) == 6


def sse_events(text: str) -> list[tuple[str, dict[str, Any]]]:
    import json

    events = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line)
        if "event" in lines:
            events.append((lines["event"], json.loads(lines["data"])))
    return events


def test_a_message_can_be_streamed_as_server_sent_events(api: TestClient) -> None:
    cid = create(api)
    response = api.post(
        f"/conversations/{cid}/messages",
        json={"content": "hello"},
        headers={**ALICE, "Accept": "text/event-stream"},
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events = sse_events(response.text)
    names = [name for name, _ in events]
    assert names[0] == "run.started" and names[-1] == "run.ended"
    ended = events[-1][1]
    shown = "".join(d["text"] for n, d in events if n == "message.delta")
    assert shown == ended["content"] and ended["end_state"] == "answered"
    # The stored message is the one that was streamed.
    stored = api.get(f"/conversations/{cid}/messages", headers=ALICE).json()["items"]
    assert stored[-1]["content"] == ended["content"]


def test_a_streamed_message_is_still_limited_and_owned(api: TestClient) -> None:
    cid = create(api, ALICE)
    other = api.post(
        f"/conversations/{cid}/messages",
        json={"content": "hello"},
        headers={**BOB, "Accept": "text/event-stream"},
    )
    assert other.status_code == 404
