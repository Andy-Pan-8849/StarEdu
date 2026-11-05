"""文件：测试——文档管理与阅读接口（集成）
测什么：在临时数据库上、使用真实的入库 worker：管理接口需要登录且只有 RAGETLAdmin 能用；
上传被接受并排队；重复上传是冲突（指出已有文档）；坏文件、缺字段、超过 20 MB、
  带路径的文件名都处理妥当；
从上传到可检索，且只有该读的人能检索到；引用原文可连同前后块查看；改权限时文档和块一起移动；
草稿不可读；职等要求可设置和清除；删除保留审计；重新入库替换文本块；列表筛选与分页；
CORS 只允许前端来源。
"""

import asyncio
import time
from collections.abc import Iterator
from typing import Any

import jwt
import psycopg
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from starit_api import main
from starit_api.deps import get_storage, get_verifier
from starit_core.auth import Identity, TokenVerifier
from starit_core.config import Settings, get_settings
from starit_core.embeddings import FakeEmbeddingClient
from starit_core.ingest.worker import run_worker
from starit_core.retrieval import retrieve
from starit_core.storage import InMemoryStorage

pytestmark = pytest.mark.integration

ISSUER = "http://localhost:8080/realms/starit"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
ROLES = ["student", "staff", "manager", "hr", "finance", "Admin", "RAGETLAdmin"]
SETTINGS = Settings(_env_file=None, embedding_provider="fake")
NOTE = (
    b"# Travel notes\n\n## Hotels\n\nThe hotel limit in tier 1 cities is CNY 600 per night. "
    b"Claims above the limit need approval from the finance controller.\n\n## Meals\n\n"
    b"The meal allowance is CNY 100 per day for domestic trips.\n"
)


def headers(role: str, user: str | None = None, campus: str = "BJ") -> dict[str, str]:
    payload = {
        "sub": user or f"{role}-user", "iss": ISSUER, "aud": ["starit-api"],
        "exp": int(time.time()) + 300, "realm_access": {"roles": [role]},
        "campus_id": campus, "level": "S2",
    }  # fmt: skip
    return {"Authorization": "Bearer " + jwt.encode(payload, KEY, algorithm="RS256")}


ADMIN = headers("RAGETLAdmin")


def form(**overrides: str) -> dict[str, str]:
    base = {
        "doc_code": "TST-001", "title": "Travel notes", "domain": "finance", "version": "1.0",
        "access_level": "all-staff",
    }  # fmt: skip
    return {**base, **overrides}


@pytest.fixture
def env(
    scratch_urls: tuple[str, str], monkeypatch: pytest.MonkeyPatch
) -> Iterator[tuple[TestClient, InMemoryStorage]]:
    owner_dsn = scratch_urls[0].replace("+psycopg", "")
    with psycopg.connect(owner_dsn, autocommit=True) as owner:
        owner.execute("TRUNCATE ai.documents CASCADE")
    monkeypatch.setenv("STARIT_DATABASE_URL", scratch_urls[1])
    get_settings.cache_clear()
    storage = InMemoryStorage()
    verifier = TokenVerifier(
        issuer=ISSUER, audience="starit-api", key_resolver=lambda _t: KEY.public_key()
    )
    app = main.create_app()
    app.dependency_overrides[get_verifier] = lambda: verifier
    app.dependency_overrides[get_storage] = lambda: storage
    with TestClient(app) as client:
        yield client, storage
    get_settings.cache_clear()


def upload(client: TestClient, data: bytes = NOTE, name: str = "notes.md", **fields: str) -> Any:
    return client.post(
        "/documents", headers=ADMIN, data=form(**fields), files={"file": (name, data)}
    )


def run_ingest(scratch_urls: tuple[str, str], storage: InMemoryStorage) -> None:
    async def go() -> None:
        engine = create_async_engine(scratch_urls[1])
        try:
            await run_worker(engine, storage, FakeEmbeddingClient(), SETTINGS, once=True)
        finally:
            await engine.dispose()

    asyncio.run(go())


def sql(scratch_urls: tuple[str, str], statement: str, **params: Any) -> list[tuple[Any, ...]]:
    async def go() -> list[tuple[Any, ...]]:
        engine = create_async_engine(scratch_urls[0])
        try:
            async with engine.connect() as conn:
                return [tuple(r) for r in (await conn.execute(text(statement), params)).all()]
        finally:
            await engine.dispose()

    return asyncio.run(go())


# --- who may manage -------------------------------------------------------------------------

SOME_ID = "00000000-0000-0000-0000-000000000001"
MANAGEMENT = [
    ("POST", "/documents"),
    ("GET", "/documents"),
    ("GET", f"/documents/{SOME_ID}"),
    ("PATCH", f"/documents/{SOME_ID}"),
    ("DELETE", f"/documents/{SOME_ID}"),
    ("POST", f"/documents/{SOME_ID}/reindex"),
    ("GET", f"/documents/{SOME_ID}/jobs"),
]


@pytest.mark.parametrize(("method", "path"), MANAGEMENT)
def test_management_needs_a_login(env: Any, method: str, path: str) -> None:
    assert env[0].request(method, path).status_code == 401


@pytest.mark.parametrize("role", [r for r in ROLES if r != "RAGETLAdmin"])
@pytest.mark.parametrize(("method", "path"), MANAGEMENT)
def test_only_the_etl_admin_may_manage(env: Any, role: str, method: str, path: str) -> None:
    response = env[0].request(method, path, headers=headers(role), json={"title": "x"})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden"


def test_the_etl_admin_gets_past_the_door(env: Any) -> None:
    client = env[0]
    assert client.get("/documents", headers=ADMIN).status_code == 200
    assert client.get(f"/documents/{SOME_ID}", headers=ADMIN).status_code == 404


# --- upload ---------------------------------------------------------------------------------


def test_upload_is_accepted_and_queued(env: Any) -> None:
    client, storage = env
    response = upload(client)
    assert response.status_code == 202
    body = response.json()
    assert body["document"]["ingest_status"] == "queued" and body["job_id"]
    assert body["document"]["format"] == "md" and body["document"]["uploaded_by"]
    assert "documents/TST-001/1.0/notes.md" in storage.objects


def test_a_repeated_upload_is_a_conflict_that_names_the_existing_document(env: Any) -> None:
    client, _ = env
    first = upload(client).json()["document"]["id"]
    again = upload(client)
    assert again.status_code == 409 and first in again.json()["error"]["message"]


@pytest.mark.parametrize(
    ("data", "name", "fields"),
    [
        (NOTE, "notes.exe", {}),
        (NOTE, "notes", {}),
        (b"", "notes.md", {}),
        (b"not a pdf", "notes.pdf", {}),
        (b"not a zip", "notes.docx", {}),
        (b"abc\x00def", "notes.txt", {}),
        (b"\xff\xfe\xfa", "notes.md", {}),
        (NOTE, "notes.md", {"access_level": "everyone"}),
        (NOTE, "notes.md", {"doc_code": "bad code!"}),
        (NOTE, "notes.md", {"version": "../1"}),
        (NOTE, "notes.md", {"domain": "sales"}),
        (NOTE, "notes.md", {"status": "deleted"}),
        (NOTE, "notes.md", {"min_level": "9"}),
        (NOTE, "notes.md", {"title": ""}),
    ],
)
def test_bad_uploads_are_refused(env: Any, data: bytes, name: str, fields: dict[str, str]) -> None:
    response = upload(env[0], data, name, **fields)
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "validation_error"
    assert env[1].objects == {}


def test_a_missing_field_is_refused(env: Any) -> None:
    fields = form()
    del fields["version"]
    response = env[0].post("/documents", headers=ADMIN, data=fields, files={"file": ("a.md", NOTE)})
    assert response.status_code == 422


def test_a_file_over_20_mb_is_refused(env: Any) -> None:
    response = upload(env[0], b"x" * (20 * 1024 * 1024 + 1), "big.txt")
    assert response.status_code == 422 and env[1].objects == {}


def test_a_path_in_the_file_name_is_not_used(env: Any) -> None:
    upload(env[0], name="../../etc/passwd.md")
    assert list(env[1].objects) == ["documents/TST-001/1.0/passwd.md"]


# --- the whole flow ---------------------------------------------------------------------------


def test_from_upload_to_searchable_for_the_right_people_only(
    env: Any, scratch_urls: tuple[str, str]
) -> None:
    client, storage = env
    document_id = upload(client).json()["document"]["id"]
    run_ingest(scratch_urls, storage)

    document = client.get(f"/documents/{document_id}", headers=ADMIN).json()
    assert document["ingest_status"] == "ready"
    jobs = client.get(f"/documents/{document_id}/jobs", headers=ADMIN).json()["items"]
    assert [j["status"] for j in jobs] == ["succeeded"]

    def search(role: str) -> int:
        async def go() -> int:
            engine = create_async_engine(scratch_urls[1])
            identity = Identity(f"{role}-user", None, None, frozenset({role}), "BJ", "S2")
            try:
                async with engine.connect() as conn:
                    found = await retrieve(
                        conn,
                        identity,
                        "hotel limit tier 1",
                        mode="keyword",
                        settings=SETTINGS,
                        embedder=FakeEmbeddingClient(),
                    )
                return len(found.chunks)
            finally:
                await engine.dispose()

        return asyncio.run(go())

    assert search("staff") > 0 and search("finance") > 0
    assert search("student") == 0 and search("RAGETLAdmin") == 0

    for role, expected in [("staff", 200), ("student", 404), ("RAGETLAdmin", 404)]:
        chunks = client.get(f"/documents/{document_id}/chunks", headers=headers(role))
        original = client.get(f"/documents/{document_id}/file", headers=headers(role))
        assert (chunks.status_code, original.status_code) == (expected, expected), role
    readable = client.get(f"/documents/{document_id}/chunks", headers=headers("staff")).json()
    assert readable["document"]["doc_code"] == "TST-001" and readable["chunks"]
    assert any("CNY 600" in c["text"] for c in readable["chunks"])
    assert client.get(f"/documents/{document_id}/file", headers=headers("staff")).content == NOTE


def test_a_chunk_can_be_viewed_with_its_neighbours(env: Any, scratch_urls: tuple[str, str]) -> None:
    client, storage = env
    long = b"".join(
        b"## Part %d\n\n" % n + b"Sentence about topic %d. " % n * 60 + b"\n\n" for n in range(8)
    )
    document_id = upload(client, long, "long.md").json()["document"]["id"]
    run_ingest(scratch_urls, storage)
    everything = client.get(f"/documents/{document_id}/chunks", headers=headers("staff")).json()
    assert len(everything["chunks"]) >= 5
    middle = everything["chunks"][len(everything["chunks"]) // 2]["id"]
    near = client.get(
        f"/documents/{document_id}/chunks?around={middle}&window=1", headers=headers("staff")
    ).json()["chunks"]
    assert middle in [c["id"] for c in near] and len(near) == 3


def test_changing_permissions_moves_the_document_and_its_chunks_together(
    env: Any, scratch_urls: tuple[str, str]
) -> None:
    client, storage = env
    document_id = upload(client).json()["document"]["id"]
    run_ingest(scratch_urls, storage)
    patched = client.patch(
        f"/documents/{document_id}",
        headers=ADMIN,
        json={"access_level": "hr-only", "title": "HR travel notes"},
    )
    assert patched.status_code == 200 and patched.json()["title"] == "HR travel notes"
    chunk_roles = sql(
        scratch_urls,
        "SELECT DISTINCT allowed_roles FROM ai.document_chunks WHERE document_id = :d",
        d=document_id,
    )
    assert chunk_roles == [(["hr"],)]
    assert (
        client.get(f"/documents/{document_id}/chunks", headers=headers("staff")).status_code == 404
    )
    assert client.get(f"/documents/{document_id}/chunks", headers=headers("hr")).status_code == 200


def test_a_draft_cannot_be_read(env: Any, scratch_urls: tuple[str, str]) -> None:
    client, storage = env
    document_id = upload(client).json()["document"]["id"]
    run_ingest(scratch_urls, storage)
    client.patch(f"/documents/{document_id}", headers=ADMIN, json={"status": "draft"})
    assert (
        client.get(f"/documents/{document_id}/chunks", headers=headers("staff")).status_code == 404
    )


@pytest.mark.parametrize(
    "body",
    [{"access_level": "everyone"}, {"status": "gone"}, {"campus_scope": []}, {"min_level": 12}],
)
def test_bad_changes_are_refused(env: Any, body: dict[str, Any]) -> None:
    document_id = upload(env[0]).json()["document"]["id"]
    assert env[0].patch(f"/documents/{document_id}", headers=ADMIN, json=body).status_code == 422


def test_the_grade_requirement_can_be_set_and_cleared(env: Any) -> None:
    client, _ = env
    document_id = upload(client).json()["document"]["id"]
    set_ = client.patch(f"/documents/{document_id}", headers=ADMIN, json={"min_level": 4})
    assert set_.json()["min_level_rank"] == 4
    cleared = client.patch(f"/documents/{document_id}", headers=ADMIN, json={"min_level": None})
    assert cleared.json()["min_level_rank"] is None


def test_delete_removes_everything_and_keeps_the_audit(
    env: Any, scratch_urls: tuple[str, str]
) -> None:
    client, storage = env
    document_id = upload(client).json()["document"]["id"]
    run_ingest(scratch_urls, storage)
    assert client.delete(f"/documents/{document_id}", headers=ADMIN).status_code == 204
    assert client.get(f"/documents/{document_id}", headers=ADMIN).status_code == 404
    assert storage.objects == {}
    assert sql(
        scratch_urls,
        "SELECT count(*) FROM ai.document_chunks WHERE document_id = :d",
        d=document_id,
    ) == [(0,)]
    actions = {r[0] for r in sql(scratch_urls, "SELECT action FROM ai.audit_log")}
    assert {"doc.upload", "doc.delete"} <= actions
    assert client.delete(f"/documents/{document_id}", headers=ADMIN).status_code == 404


def test_reindex_queues_a_new_job_and_replaces_the_chunks(
    env: Any, scratch_urls: tuple[str, str]
) -> None:
    client, storage = env
    document_id = upload(client).json()["document"]["id"]
    run_ingest(scratch_urls, storage)
    before = sql(
        scratch_urls, "SELECT id FROM ai.document_chunks WHERE document_id = :d", d=document_id
    )
    response = client.post(f"/documents/{document_id}/reindex", headers=ADMIN)
    assert response.status_code == 202 and response.json()["job_id"]
    assert (
        client.get(f"/documents/{document_id}", headers=ADMIN).json()["ingest_status"] == "queued"
    )
    run_ingest(scratch_urls, storage)
    after = sql(
        scratch_urls, "SELECT id FROM ai.document_chunks WHERE document_id = :d", d=document_id
    )
    assert after and set(after).isdisjoint(before)
    assert len(client.get(f"/documents/{document_id}/jobs", headers=ADMIN).json()["items"]) == 2


def test_listing_filters_and_pages(env: Any) -> None:
    client, _ = env
    for n, domain in enumerate(["hr", "finance", "finance"], start=1):
        upload(client, doc_code=f"TST-00{n}", domain=domain, title=f"Policy number {n}")
    everything = client.get("/documents?limit=2", headers=ADMIN).json()
    assert len(everything["items"]) == 2 and everything["next_cursor"]
    second = client.get(
        f"/documents?limit=2&cursor={everything['next_cursor']}", headers=ADMIN
    ).json()
    assert len(second["items"]) == 1 and second["next_cursor"] is None
    ids = [d["id"] for d in everything["items"] + second["items"]]
    assert len(set(ids)) == 3
    assert len(client.get("/documents?domain=finance", headers=ADMIN).json()["items"]) == 2
    assert len(client.get("/documents?q=number 3", headers=ADMIN).json()["items"]) == 1
    assert len(client.get("/documents?q=TST-001", headers=ADMIN).json()["items"]) == 1
    assert client.get("/documents?q=%25", headers=ADMIN).json()["items"] == []
    assert client.get("/documents?ingest_status=ready", headers=ADMIN).json()["items"] == []
    assert client.get("/documents?limit=0", headers=ADMIN).status_code == 422
    assert client.get("/documents?cursor=garbage", headers=ADMIN).status_code == 422
    assert "content" not in everything["items"][0] and "text" not in everything["items"][0]


# --- browsers ---------------------------------------------------------------------------------


def test_cors_allows_the_front_end_origin_only(env: Any) -> None:
    client, _ = env
    ask = {
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
    }
    allowed = client.options("/documents", headers={"Origin": "http://localhost:3000", **ask})
    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == "http://localhost:3000"
    refused = client.options("/documents", headers={"Origin": "http://evil.example", **ask})
    assert "access-control-allow-origin" not in refused.headers
    plain = client.get("/documents", headers={**ADMIN, "Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in plain.headers
