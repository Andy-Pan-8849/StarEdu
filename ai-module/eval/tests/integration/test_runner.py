"""The evaluation runner end to end on the ingested sample documents (fake models)."""

import asyncio
from collections.abc import AsyncIterator

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from starit_core.config import Settings
from starit_core.embeddings import FakeEmbeddingClient
from starit_core.ingest.register import register_from_manifest
from starit_core.ingest.worker import run_worker
from starit_core.llm import FakeChatClient
from starit_core.retrieval import MODES
from starit_core.retrieval.rerank import LLMReranker
from starit_core.storage import InMemoryStorage
from starit_eval.dataset import SAMPLE_DATA, load_identities, load_manifest, load_questions
from starit_eval.report import build_report, store_run
from starit_eval.runner import embed_questions, evaluate_mode, leak_sweep

pytestmark = pytest.mark.integration

SETTINGS = Settings(_env_file=None, embedding_provider="fake")
EMBEDDER = FakeEmbeddingClient()


@pytest.fixture(scope="module")
def ingested(scratch_urls: tuple[str, str]) -> tuple[str, str]:
    async def run() -> None:
        engine = create_async_engine(scratch_urls[1])
        storage = InMemoryStorage()
        await register_from_manifest(engine, storage, SAMPLE_DATA / "documents")
        await run_worker(engine, storage, EMBEDDER, SETTINGS, once=True)
        await engine.dispose()

    asyncio.run(run())
    return scratch_urls


@pytest.fixture
async def engine(ingested: tuple[str, str]) -> AsyncIterator[AsyncEngine]:
    engine = create_async_engine(ingested[1])
    yield engine
    await engine.dispose()


async def test_every_mode_runs_every_question_and_nothing_leaks(engine: AsyncEngine) -> None:
    questions, identities, manifest = load_questions(), load_identities(), load_manifest()
    vectors, tokens = await embed_questions(EMBEDDER, questions)
    assert len(vectors) == len(load_questions()) and tokens > 0
    reranker = LLMReranker(FakeChatClient(lambda _m: '{"ranking": []}'), "m")
    for mode in MODES:
        run = await evaluate_mode(
            engine, SETTINGS, EMBEDDER, reranker if mode == "hybrid_rerank" else None,
            questions, identities, manifest, vectors, mode,
        )  # fmt: skip
        assert len(run.runs) == len(load_questions()), mode
        assert all(not r.violations for r in run.runs), mode
        # Admin and RAGETLAdmin have no business role and read nothing; everyone else who asks
        # an answerable question gets something back (the corpus is small).
        for r in run.runs:
            if r.question.role in ("Admin", "RAGETLAdmin"):
                assert not r.doc_codes, (mode, r.question.id)
            elif r.question.should_answer:
                assert r.doc_codes, (mode, r.question.id)
        assert all(r.latency_ms > 0 for r in run.runs)
    assert (
        run.rerank_failures == len(load_questions()) - 2
    )  # nothing usable each time; Admin and RAGETLAdmin have no candidates to rerank


async def test_the_sweep_checks_every_role_question_and_mode(engine: AsyncEngine) -> None:
    questions, identities, manifest = load_questions(), load_identities(), load_manifest()
    vectors, _ = await embed_questions(EMBEDDER, questions)
    sweep = await leak_sweep(engine, SETTINGS, EMBEDDER, questions, identities, manifest, vectors)
    assert sweep.checked == 7 * len(load_questions()) * 3
    assert sweep.violations == []


async def test_a_run_is_stored_in_the_database(engine: AsyncEngine) -> None:
    questions, identities, manifest = load_questions(), load_identities(), load_manifest()
    vectors, tokens = await embed_questions(EMBEDDER, questions)
    run = await evaluate_mode(
        engine, SETTINGS, EMBEDDER, None, questions, identities, manifest, vectors, "keyword"
    )
    report = build_report(
        label="stored", settings=SETTINGS, corpus={"documents": 28, "chunks": 39, "avg_tokens": 286},
        mode_runs=[run], sweep=None, embedding_tokens=tokens, rerank_model="x", embedding_model="fake",
    )  # fmt: skip
    run_id = await store_run(engine, run, report)
    async with engine.connect() as conn:
        count = (
            await conn.execute(
                text("SELECT count(*) FROM ai.eval_results WHERE run_id = :r"), {"r": run_id}
            )
        ).scalar()
        summary = (
            await conn.execute(
                text("SELECT summary->'overall'->>'n' FROM ai.eval_runs WHERE id = :r"),
                {"r": run_id},
            )
        ).scalar()
        config_mode = (
            await conn.execute(
                text("SELECT config->>'mode' FROM ai.eval_runs WHERE id = :r"), {"r": run_id}
            )
        ).scalar()
    assert count == len(load_questions())
    assert summary == str(report["modes"]["keyword"]["overall"]["n"])
    assert config_mode == "keyword"
