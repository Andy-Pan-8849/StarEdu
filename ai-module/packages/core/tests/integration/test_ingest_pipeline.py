"""Ingestion end to end on a scratch database, with fake embeddings and in-memory storage."""

import asyncio
import csv
import json
import shutil
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine
from starit_core.config import Settings
from starit_core.embeddings import FakeEmbeddingClient
from starit_core.ingest import queue
from starit_core.ingest.errors import IngestError
from starit_core.ingest.register import register_from_manifest
from starit_core.ingest.worker import run_worker
from starit_core.permissions import expand_access_level
from starit_core.storage import InMemoryStorage

pytestmark = pytest.mark.integration

SAMPLE_DATA = Path(__file__).resolve().parents[4] / "sample-data"
DOCUMENTS = SAMPLE_DATA / "documents"
SETTINGS = Settings(_env_file=None, embedding_provider="fake")


def manifest() -> list[dict[str, str]]:
    with open(DOCUMENTS / "manifest.csv", newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


async def scalar(engine: AsyncEngine, sql: str, **params: object) -> Any:
    async with engine.connect() as conn:
        return (await conn.execute(text(sql), params)).scalar()


async def rows(engine: AsyncEngine, sql: str, **params: object) -> list[tuple[Any, ...]]:
    async with engine.connect() as conn:
        return [tuple(r) for r in (await conn.execute(text(sql), params)).all()]


async def ingest_all(
    app: AsyncEngine, storage: InMemoryStorage, documents: Path = DOCUMENTS
) -> None:
    await register_from_manifest(app, storage, documents)
    await run_worker(app, storage, FakeEmbeddingClient(), SETTINGS, once=True)


class FlakyEmbedder:
    """Fails like a provider outage."""

    model = "flaky"
    dimensions = 1536

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        raise IngestError("embed", "embedding_failed", "provider unavailable")


class SlowEmbedder(FakeEmbeddingClient):
    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        await asyncio.sleep(0.05)  # lets two workers overlap
        return await super().embed(texts)


def copy_documents(destination: Path, only: set[str] | None = None) -> Path:
    shutil.copytree(DOCUMENTS, destination)
    if only is not None:
        kept = [r for r in manifest() if r["doc_id"] in only]
        with open(destination / "manifest.csv", "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(kept[0]))
            writer.writeheader()
            writer.writerows(kept)
    return destination


async def test_every_sample_document_is_ingested(
    engines: tuple[AsyncEngine, AsyncEngine],
) -> None:
    owner, app = engines
    storage = InMemoryStorage()
    await ingest_all(app, storage)

    expected = manifest()
    assert len(expected) == 28
    assert await scalar(owner, "SELECT count(*) FROM ai.documents") == 28
    assert (
        await scalar(owner, "SELECT count(*) FROM ai.documents WHERE ingest_status = 'ready'") == 28
    )
    assert (
        await scalar(owner, "SELECT count(*) FROM ai.ingestion_jobs WHERE status = 'succeeded'")
        == 28
    )
    assert len(storage.objects) == 28

    # Every document has chunks, and they carry the document's access rules.
    per_document = await rows(
        owner,
        "SELECT d.doc_code, d.version, d.access_level, count(c.id), "
        "array_agg(DISTINCT c.allowed_roles::text), min(c.token_count) "
        "FROM ai.documents d LEFT JOIN ai.document_chunks c ON c.document_id = d.id "
        "GROUP BY 1, 2, 3",
    )
    assert len(per_document) == 28
    for code, version, access, chunk_count, role_sets, smallest in per_document:
        assert chunk_count >= 1, (code, version)
        assert smallest > 0
        assert role_sets == ["{" + ",".join(expand_access_level(str(access))) + "}"], code

    assert await rows(owner, "SELECT * FROM ai.v_chunk_permission_drift") == []

    # Each chunk has one embedding row that records the model and its width.
    assert (
        await scalar(
            owner,
            "SELECT count(*) FROM ai.document_chunks c LEFT JOIN ai.chunk_embeddings e "
            "ON e.chunk_id = c.id WHERE e.chunk_id IS NULL",
        )
        == 0
    )
    assert await rows(owner, "SELECT DISTINCT model, dimensions FROM ai.chunk_embeddings") == [
        ("fake-embedding", 1536)
    ]
    assert (
        await scalar(owner, "SELECT count(*) FROM ai.audit_log WHERE action = 'doc.ingest'") == 28
    )


async def test_both_versions_of_the_recruitment_policy_are_kept(
    engines: tuple[AsyncEngine, AsyncEngine],
) -> None:
    owner, app = engines
    await ingest_all(app, InMemoryStorage())
    versions = await rows(
        owner,
        "SELECT version, status, (supersedes_id IS NOT NULL) FROM ai.documents "
        "WHERE doc_code = 'HR-REC-001' ORDER BY version",
    )
    assert versions == [("1.0", "superseded", False), ("2.1", "active", True)]
    chunk_status = await rows(
        owner,
        "SELECT DISTINCT version, status FROM ai.document_chunks WHERE doc_code = 'HR-REC-001' ORDER BY 1",
    )
    assert chunk_status == [("1.0", "superseded"), ("2.1", "active")]


async def test_exact_identifiers_are_found_in_the_right_documents(
    engines: tuple[AsyncEngine, AsyncEngine],
) -> None:
    owner, app = engines
    await ingest_all(app, InMemoryStorage())
    lines = (SAMPLE_DATA / "eval" / "qa-set.jsonl").read_text(encoding="utf-8").splitlines()
    questions = {q["id"]: q for q in map(json.loads, lines)}
    cases = {
        "DOC-29": "ERR-PORTAL-403",
        "DOC-30": "ERR-PORTAL-429",
        "DOC-24": "91510000FAKE00001X",
    }
    for question_id, identifier in cases.items():
        hits = {
            r[0]
            for r in await rows(
                owner,
                "SELECT doc_code FROM ai.document_chunks "
                "WHERE tsv @@ phraseto_tsquery('english', :q)",
                q=identifier,
            )
        }
        sources = set(questions[question_id]["source_docs"])
        assert hits & sources, (identifier, hits, sources)
        assert identifier in {
            i
            for (ids,) in await rows(owner, "SELECT identifiers FROM ai.document_chunks")
            for i in ids
        }


async def test_running_it_again_changes_nothing(engines: tuple[AsyncEngine, AsyncEngine]) -> None:
    owner, app = engines
    storage = InMemoryStorage()
    await ingest_all(app, storage)
    before = await rows(owner, "SELECT id, text FROM ai.document_chunks ORDER BY id")

    results = await register_from_manifest(app, storage, DOCUMENTS)
    assert {r.action for r in results} == {"unchanged"}
    handled = await run_worker(app, storage, FakeEmbeddingClient(), SETTINGS, once=True)
    assert handled == 0
    assert await rows(owner, "SELECT id, text FROM ai.document_chunks ORDER BY id") == before
    assert await scalar(owner, "SELECT count(*) FROM ai.ingestion_jobs") == 28


async def test_a_changed_file_replaces_only_that_documents_chunks(
    engines: tuple[AsyncEngine, AsyncEngine], tmp_path: Path
) -> None:
    owner, app = engines
    storage = InMemoryStorage()
    documents = copy_documents(tmp_path / "docs")
    await ingest_all(app, storage, documents)
    before = {r[0]: r[1] for r in await rows(owner, "SELECT id, doc_code FROM ai.document_chunks")}

    target = documents / "tech-support/TS-ENV-002_python-environment-setup.md"
    target.write_text(
        target.read_text() + "\n## 99. New section\n\nA brand new rule about ZZ-NEW-001.\n"
    )
    results = await register_from_manifest(app, storage, documents)
    assert [r.doc_code for r in results if r.action == "updated"] == ["TS-ENV-002"]
    assert await run_worker(app, storage, FakeEmbeddingClient(), SETTINGS, once=True) == 1

    after = {r[0]: r[1] for r in await rows(owner, "SELECT id, doc_code FROM ai.document_chunks")}
    untouched = {k for k, v in before.items() if v != "TS-ENV-002"}
    assert untouched <= set(after)  # other documents keep the very same chunk rows
    assert not {k for k, v in before.items() if v == "TS-ENV-002"} & set(after)  # replaced
    assert (
        await scalar(
            owner, "SELECT count(*) FROM ai.document_chunks WHERE text LIKE '%ZZ-NEW-001%'"
        )
        == 1
    )
    assert await rows(owner, "SELECT * FROM ai.v_chunk_permission_drift") == []


async def test_a_corrupt_file_fails_with_its_stage_and_reason(
    engines: tuple[AsyncEngine, AsyncEngine], tmp_path: Path
) -> None:
    owner, app = engines
    documents = copy_documents(tmp_path / "docs", only={"FIN-REIM-002"})
    (documents / "finance/FIN-REIM-002_travel-and-accommodation.pdf").write_bytes(b"not a pdf" * 20)
    storage = InMemoryStorage()
    await ingest_all(app, storage, documents)

    job = (await rows(owner, "SELECT status, stage, error_code, attempt FROM ai.ingestion_jobs"))[0]
    assert job[:3] == ("failed", "parse", "parse_failed")
    assert job[3] == 1  # a corrupt file is not retried
    assert await scalar(owner, "SELECT ingest_status FROM ai.documents") == "failed"
    assert await scalar(owner, "SELECT count(*) FROM ai.document_chunks") == 0


async def test_a_missing_stored_file_is_reported(engines: tuple[AsyncEngine, AsyncEngine]) -> None:
    owner, app = engines
    storage = InMemoryStorage()
    await register_from_manifest(app, storage, DOCUMENTS)
    storage.objects.clear()
    await run_worker(app, storage, FakeEmbeddingClient(), SETTINGS, once=True)
    assert (
        await scalar(
            owner, "SELECT count(*) FROM ai.ingestion_jobs WHERE error_code = 'object_missing'"
        )
        == 28
    )


async def test_an_embedding_failure_keeps_the_old_chunks_and_is_retried_then_given_up(
    engines: tuple[AsyncEngine, AsyncEngine], tmp_path: Path
) -> None:
    owner, app = engines
    storage = InMemoryStorage()
    documents = copy_documents(tmp_path / "docs", only={"TS-ENV-001"})
    await ingest_all(app, storage, documents)
    old_chunks = await rows(owner, "SELECT id, text FROM ai.document_chunks ORDER BY id")
    assert old_chunks

    target = documents / "tech-support/TS-ENV-001_java-environment-setup.md"
    target.write_text(target.read_text() + "\n## 99. Extra\n\nMore text.\n")
    await register_from_manifest(app, storage, documents)

    for attempt in (1, 2, 3):
        await run_worker(app, storage, FlakyEmbedder(), SETTINGS, once=True)
        status, stage, code, attempts = (
            await rows(
                owner,
                "SELECT status, stage, error_code, attempt FROM ai.ingestion_jobs ORDER BY started_at DESC LIMIT 1",
            )
        )[0]
        assert (stage, code, attempts) == ("embed", "embedding_failed", attempt)
        # Chunks of the previous version stay searchable the whole time.
        assert (
            await rows(owner, "SELECT id, text FROM ai.document_chunks ORDER BY id") == old_chunks
        )
        if attempt < 3:
            assert status == "queued"
            delay = await scalar(
                owner,
                "SELECT extract(epoch FROM run_after - now()) FROM ai.ingestion_jobs WHERE status = 'queued'",
            )
            assert 0 < float(delay) <= queue.BACKOFF_SECONDS[attempt - 1]
            await owner_exec(
                owner, "UPDATE ai.ingestion_jobs SET run_after = now() WHERE status = 'queued'"
            )
        else:
            assert status == "failed"
    assert await scalar(owner, "SELECT ingest_status FROM ai.documents") == "failed"


async def owner_exec(engine: AsyncEngine, sql: str) -> None:
    async with engine.begin() as conn:
        await conn.execute(text(sql))


async def test_a_vector_width_that_does_not_fit_the_column_fails_without_retry(
    engines: tuple[AsyncEngine, AsyncEngine], tmp_path: Path
) -> None:
    owner, app = engines
    storage = InMemoryStorage()
    await register_from_manifest(
        app, storage, copy_documents(tmp_path / "docs", only={"HR-GEN-000"})
    )
    await run_worker(app, storage, FakeEmbeddingClient(dimensions=768), SETTINGS, once=True)
    row = (await rows(owner, "SELECT status, error_code, attempt FROM ai.ingestion_jobs"))[0]
    assert row == ("failed", "unsupported_dimensions", 1)
    assert await scalar(owner, "SELECT count(*) FROM ai.document_chunks") == 0


async def test_two_workers_never_take_the_same_job(
    engines: tuple[AsyncEngine, AsyncEngine], tmp_path: Path
) -> None:
    owner, app = engines
    storage = InMemoryStorage()
    await register_from_manifest(
        app,
        storage,
        copy_documents(
            tmp_path / "docs",
            only={
                "HR-GEN-000",
                "HR-LEV-007",
                "HR-WRK-008",
                "TS-ENV-001",
                "TS-ENV-002",
                "TS-ENV-003",
            },
        ),
    )
    handled = await asyncio.gather(
        run_worker(app, storage, SlowEmbedder(), SETTINGS, once=True, worker_id="worker-a"),
        run_worker(app, storage, SlowEmbedder(), SETTINGS, once=True, worker_id="worker-b"),
    )
    assert sum(handled) == 6
    assert all(n >= 1 for n in handled)  # the work was really shared
    assert await rows(owner, "SELECT DISTINCT attempt FROM ai.ingestion_jobs") == [(1,)]
    assert await scalar(owner, "SELECT count(*) FROM ai.audit_log WHERE action = 'doc.ingest'") == 6


async def test_the_queue_does_not_double_book_a_document_and_revives_stalled_jobs(
    engines: tuple[AsyncEngine, AsyncEngine], tmp_path: Path
) -> None:
    owner, app = engines
    storage = InMemoryStorage()
    await register_from_manifest(
        app, storage, copy_documents(tmp_path / "docs", only={"HR-GEN-000"})
    )
    document_id = await scalar(owner, "SELECT id FROM ai.documents")
    async with app.begin() as conn:
        first = await queue.enqueue(conn, document_id)
        again = await queue.enqueue(conn, document_id)
    assert first == again
    assert await scalar(owner, "SELECT count(*) FROM ai.ingestion_jobs") == 1

    async with app.begin() as conn:
        job = await queue.claim_next(conn, "worker-x")
    assert job is not None and job.attempt == 1
    async with app.begin() as conn:
        assert await queue.claim_next(conn, "worker-y") is None  # already taken
        assert await queue.requeue_stale(conn, 900) == 0  # not stalled yet
    await owner_exec(owner, "UPDATE ai.ingestion_jobs SET locked_at = now() - interval '1 hour'")
    async with app.begin() as conn:
        assert await queue.requeue_stale(conn, 900) == 1
        revived = await queue.claim_next(conn, "worker-y")
    assert revived is not None and revived.attempt == 2


async def test_forcing_a_new_run_re_embeds_with_the_new_model(
    engines: tuple[AsyncEngine, AsyncEngine], tmp_path: Path
) -> None:
    owner, app = engines
    storage = InMemoryStorage()
    documents = copy_documents(tmp_path / "docs", only={"HR-GEN-000", "TS-ENV-001"})
    await ingest_all(app, storage, documents)
    assert await rows(owner, "SELECT DISTINCT model FROM ai.chunk_embeddings") == [
        ("fake-embedding",)
    ]

    await register_from_manifest(app, storage, documents, force=True)
    await run_worker(app, storage, FakeEmbeddingClient(model="fake-v2"), SETTINGS, once=True)
    assert await rows(owner, "SELECT DISTINCT model FROM ai.chunk_embeddings") == [("fake-v2",)]
    assert (
        await scalar(owner, "SELECT count(*) FROM ai.ingestion_jobs WHERE status = 'succeeded'")
        == 4
    )
