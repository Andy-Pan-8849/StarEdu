"""文件：测试——知识库的导出与恢复
测什么：转储恢复后得到同样的知识库；相同内容总得到相同字节；在已有知识库上恢复会替换它；
不带 replace 时若已有文档则什么都不改；损坏的转储被拒绝且已有数据保留；
恢复后的知识库仍然保持受限文档受限；原文件按文档约定的键存放。
"""

import asyncio
import gzip
import json
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from starit_core.auth import Identity
from starit_core.config import Settings
from starit_core.embeddings import FakeEmbeddingClient
from starit_core.ingest.register import register_from_manifest
from starit_core.ingest.worker import run_worker
from starit_core.retrieval import retrieve
from starit_core.seed_ai import SeedError, dump_ai, load_ai, read_dump, upload_originals
from starit_core.storage import InMemoryStorage
from starit_core.testing import ScriptedChat

pytestmark = pytest.mark.integration

SAMPLE_DATA = Path(__file__).resolve().parents[4] / "sample-data"
SETTINGS = Settings(_env_file=None, embedding_provider="fake")
DERIVED = json.dumps({"summary": "A short summary.", "questions": ["Who?", "When?"]})


@pytest.fixture(scope="module")
def ingested(scratch_urls: tuple[str, str]) -> tuple[str, str]:
    async def run() -> None:
        engine = create_async_engine(scratch_urls[1])
        storage = InMemoryStorage()
        settings = Settings(_env_file=None, embedding_provider="fake", ingest_derive="all")
        await register_from_manifest(engine, storage, SAMPLE_DATA / "documents")
        await run_worker(
            engine, storage, FakeEmbeddingClient(), settings, once=True,
            chat=ScriptedChat(derive=DERIVED),
        )  # fmt: skip
        await engine.dispose()

    asyncio.run(run())
    return scratch_urls


@pytest.fixture
async def engine(ingested: tuple[str, str]) -> AsyncIterator[AsyncEngine]:
    engine = create_async_engine(ingested[1])
    yield engine
    await engine.dispose()


async def fingerprint(engine: AsyncEngine) -> dict[str, Any]:
    async with engine.connect() as conn:
        docs = (
            await conn.execute(
                text(
                    "SELECT doc_code, version, content_hash, access_level, allowed_roles, "
                    "campus_scope, status, ingest_status, object_key FROM ai.documents "
                    "ORDER BY 1, 2"
                )
            )
        ).all()
        chunks = (
            await conn.execute(
                text(
                    "SELECT d.doc_code, d.version, c.chunk_index, c.text, c.heading_path, "
                    "c.identifiers, c.allowed_roles, c.token_count FROM ai.document_chunks c "
                    "JOIN ai.documents d ON d.id = c.document_id ORDER BY 1, 2, 3"
                )
            )
        ).all()
        vectors = (
            await conn.execute(
                text(
                    "SELECT d.doc_code, d.version, c.chunk_index, e.model, e.dimensions, e.embedding::text "
                    "FROM ai.chunk_embeddings e JOIN ai.document_chunks c ON c.id = e.chunk_id "
                    "JOIN ai.documents d ON d.id = c.document_id ORDER BY 1, 2, 3"
                )
            )
        ).all()
        derived = (
            await conn.execute(
                text(
                    "SELECT d.doc_code, d.version, c.chunk_index, x.kind, x.text FROM ai.chunk_derived x "
                    "JOIN ai.document_chunks c ON c.id = x.chunk_id "
                    "JOIN ai.documents d ON d.id = c.document_id ORDER BY 1, 2, 3, 4, 5"
                )
            )
        ).all()
    return {"docs": docs, "chunks": chunks, "vectors": vectors, "derived": derived}


async def test_a_dump_restores_the_same_knowledge_base(engine: AsyncEngine) -> None:
    before = await fingerprint(engine)
    assert len(before["docs"]) == 28 and before["chunks"] and before["derived"]

    data = await dump_ai(engine, git_sha="abc1234")
    header, _ = read_dump(data)
    assert header["counts"]["documents"] == 28
    assert header["counts"]["chunk_derived"] == len(before["derived"])
    assert header["embedding_models"] == "fake-embedding" and header["git_sha"] == "abc1234"

    async with engine.begin() as conn:
        await conn.execute(text("DELETE FROM ai.documents"))
    restored = await load_ai(engine, data)
    assert restored["documents"] == 28 and restored["document_chunks"] == len(before["chunks"])
    assert await fingerprint(engine) == before  # text, permissions, vectors, derived: all of it


async def test_the_same_content_always_gives_the_same_bytes(engine: AsyncEngine) -> None:
    first = await dump_ai(engine)
    second = await dump_ai(engine)
    assert gzip.decompress(first).splitlines()[1:] == gzip.decompress(second).splitlines()[1:]


async def test_restoring_over_an_existing_knowledge_base_replaces_it(engine: AsyncEngine) -> None:
    data = await dump_ai(engine)
    await load_ai(engine, data)
    await load_ai(engine, data)  # twice: still one copy
    async with engine.connect() as conn:
        count = (await conn.execute(text("SELECT count(*) FROM ai.documents"))).scalar_one()
    assert count == 28


async def test_restoring_without_replace_over_existing_documents_changes_nothing(
    engine: AsyncEngine,
) -> None:
    data = await dump_ai(engine)
    before = await fingerprint(engine)
    with pytest.raises(Exception, match="duplicate|unique"):
        await load_ai(engine, data, replace=False)
    assert await fingerprint(engine) == before


async def test_a_damaged_dump_is_refused_and_the_existing_data_is_kept(engine: AsyncEngine) -> None:
    data = await dump_ai(engine)
    before = await fingerprint(engine)
    lines = gzip.decompress(data).decode().splitlines()
    header = json.loads(lines[0])
    header["counts"]["document_chunks"] += 1
    broken = gzip.compress(("\n".join([json.dumps(header), *lines[1:]]) + "\n").encode())
    with pytest.raises(SeedError, match="incomplete"):
        await load_ai(engine, broken)
    header["format"] = 99
    wrong = gzip.compress(("\n".join([json.dumps(header), *lines[1:]]) + "\n").encode())
    with pytest.raises(SeedError, match="format"):
        await load_ai(engine, wrong)
    assert await fingerprint(engine) == before


def identity(make_identity: Callable[..., Identity], role: str) -> Identity:
    return make_identity({role}, user_id=f"{role}-1", campus_id="BJ", level="S2")


async def test_a_restored_knowledge_base_still_keeps_restricted_documents_restricted(
    engine: AsyncEngine, make_identity: Callable[..., Identity]
) -> None:
    await load_ai(engine, await dump_ai(engine))
    question = "What is the pass threshold for instructor candidates?"
    async with engine.connect() as conn:

        async def codes(role: str) -> set[str]:
            found = await retrieve(
                conn, identity(make_identity, role), question, mode="keyword",
                settings=SETTINGS, embedder=FakeEmbeddingClient(),
            )  # fmt: skip
            return {c.doc_code for c in found.chunks}

        assert "HR-REC-002" in await codes("hr")
        for role in ("student", "staff", "manager", "finance", "Admin", "RAGETLAdmin"):
            assert "HR-REC-002" not in await codes(role), role
        drift = (
            await conn.execute(text("SELECT count(*) FROM ai.v_chunk_permission_drift"))
        ).scalar_one()
    assert drift == 0


async def test_originals_are_stored_under_the_keys_the_documents_name(
    engine: AsyncEngine,
) -> None:
    storage = InMemoryStorage()
    assert await upload_originals(storage, SAMPLE_DATA / "documents") == 28
    async with engine.connect() as conn:
        keys = {str(r[0]) for r in await conn.execute(text("SELECT object_key FROM ai.documents"))}
    assert keys == set(storage.objects)
