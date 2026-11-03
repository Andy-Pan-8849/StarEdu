"""Retrieval on the ingested sample documents (scratch database, fake embeddings).

The vector side is meaningless here (fake vectors), so these tests check what does not depend on
meaning: the permission filter, the plumbing of the four modes, exact identifiers (a keyword
matter), versions, and the probe. How well the real embeddings rank is measured by the
evaluation runner (starit-eval), not here.
"""

import asyncio
import csv
import json
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine
from starit_core.auth import Identity
from starit_core.config import Settings
from starit_core.embeddings import FakeEmbeddingClient
from starit_core.ingest.register import register_from_manifest
from starit_core.ingest.worker import run_worker
from starit_core.llm import FakeChatClient
from starit_core.retrieval import MODES, RetrievalResult, retrieve
from starit_core.retrieval.rerank import LLMReranker
from starit_core.storage import InMemoryStorage

pytestmark = pytest.mark.integration

SAMPLE_DATA = Path(__file__).resolve().parents[4] / "sample-data"
SETTINGS = Settings(_env_file=None, embedding_provider="fake")
EMBEDDER = FakeEmbeddingClient()


def read_csv(path: Path) -> list[dict[str, str]]:
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


ACCOUNTS = read_csv(SAMPLE_DATA / "demo-accounts.csv")
QUESTIONS = [
    json.loads(line)
    for line in (SAMPLE_DATA / "eval" / "qa-set.jsonl").read_text(encoding="utf-8").splitlines()
]
MANIFEST = {
    (r["doc_id"], r["version"]): r for r in read_csv(SAMPLE_DATA / "documents" / "manifest.csv")
}


def identity_for_role(role: str, make_identity: Callable[..., Identity]) -> Identity:
    account = next(a for a in ACCOUNTS if a["role"] == role)
    student = account["subject_type"] == "student"
    return make_identity(
        {role},
        user_id=account["username"],
        campus_id=account["campus_id"],
        level=account["level"] or None,
        employee_id=None if student else account["subject_id"],
        student_id=account["subject_id"] if student else None,
    )


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
async def conn(ingested: tuple[str, str]) -> AsyncIterator[AsyncConnection]:
    engine: AsyncEngine = create_async_engine(ingested[1])  # the application role
    async with engine.connect() as connection:
        yield connection
    await engine.dispose()


async def search(
    conn: AsyncConnection,
    identity: Identity,
    query: str,
    mode: str = "hybrid",
    *,
    probe: bool = False,
    reranker: LLMReranker | None = None,
) -> RetrievalResult:
    return await retrieve(
        conn,
        identity,
        query,
        mode=mode,
        settings=SETTINGS,
        embedder=EMBEDDER,
        reranker=reranker,
        probe=probe,
    )


def docs_of(result: RetrievalResult) -> list[str]:
    return [c.doc_code for c in result.chunks]


def question(question_id: str) -> dict[str, object]:
    return next(q for q in QUESTIONS if q["id"] == question_id)


# --- the four modes -------------------------------------------------------------------------


@pytest.mark.parametrize("mode", MODES)
async def test_every_mode_returns_complete_results(
    conn: AsyncConnection, make_identity: Callable[..., Identity], mode: str
) -> None:
    staff = identity_for_role("staff", make_identity)
    reranker = LLMReranker(FakeChatClient(lambda _m: '{"ranking": []}'), "m")  # unusable on purpose
    result = await search(
        conn, staff, "How many days of annual leave do I get?", mode, reranker=reranker
    )
    assert 0 < len(result.chunks) <= SETTINGS.retrieval_final_k
    for c in result.chunks:
        assert c.doc_code and c.title and c.version and c.status in ("active", "superseded")
        assert c.text and c.token_count > 0
    if mode == "keyword":
        assert all(c.keyword_rank and c.vector_rank is None for c in result.chunks)
    if mode == "vector":
        assert all(c.vector_rank and c.keyword_rank is None for c in result.chunks)
    if mode in ("hybrid", "hybrid_rerank"):
        assert (
            result.diagnostics.keyword_candidates > 0 and result.diagnostics.vector_candidates > 0
        )
        assert all(c.fused_score > 0 for c in result.chunks)
    assert result.diagnostics.mode == mode
    assert "keyword" in result.diagnostics.timings_ms or mode == "vector"


async def test_rerank_reorders_the_pool_and_a_bad_answer_keeps_the_fused_order(
    conn: AsyncConnection, make_identity: Callable[..., Identity]
) -> None:
    staff = identity_for_role("staff", make_identity)
    query = "late submission penalty for assignments"
    fused = await search(conn, staff, query, "hybrid")
    assert len(fused.chunks) >= 3

    def last_first(messages: Sequence[Mapping[str, str]]) -> str:
        count = messages[1]["content"].count("\n[")  # passages are numbered [1], [2], ...
        ids = list(range(count + 1, 0, -1))
        return json.dumps({"ranking": [{"id": i, "score": i} for i in ids]})

    reranked = await search(
        conn, staff, query, "hybrid_rerank", reranker=LLMReranker(FakeChatClient(last_first), "m")
    )
    assert not reranked.diagnostics.rerank_failed
    assert reranked.chunks[0].rerank_score is not None
    assert reranked.chunks[0].chunk_id != fused.chunks[0].chunk_id  # the order really changed

    broken = await search(
        conn, staff, query, "hybrid_rerank", reranker=LLMReranker(FakeChatClient(["nonsense"]), "m")
    )
    assert broken.diagnostics.rerank_failed and broken.diagnostics.rerank_error
    assert [c.chunk_id for c in broken.chunks] == [c.chunk_id for c in fused.chunks]


async def test_a_query_vector_can_be_supplied_and_other_models_vectors_are_never_compared(
    conn: AsyncConnection, make_identity: Callable[..., Identity]
) -> None:
    staff = identity_for_role("staff", make_identity)
    vector = (await EMBEDDER.embed(["annual leave"]))[0]
    same_model = await retrieve(
        conn,
        staff,
        "annual leave",
        mode="vector",
        settings=SETTINGS,
        embedder=EMBEDDER,
        query_vector=vector,
    )
    assert same_model.chunks
    other = FakeEmbeddingClient(model="some-other-model")
    other_model = await retrieve(
        conn,
        staff,
        "annual leave",
        mode="vector",
        settings=SETTINGS,
        embedder=other,
        query_vector=vector,
    )
    assert other_model.chunks == []


async def test_bad_calls_are_rejected(
    conn: AsyncConnection, make_identity: Callable[..., Identity]
) -> None:
    staff = identity_for_role("staff", make_identity)
    with pytest.raises(ValueError, match="unknown retrieval mode"):
        await retrieve(conn, staff, "q", mode="fuzzy", settings=SETTINGS, embedder=EMBEDDER)
    with pytest.raises(ValueError, match="reranker"):
        await retrieve(conn, staff, "q", mode="hybrid_rerank", settings=SETTINGS, embedder=EMBEDDER)
    with pytest.raises(ValueError, match="embedding"):
        await retrieve(conn, staff, "q", mode="vector", settings=SETTINGS)


# --- exact identifiers ----------------------------------------------------------------------


@pytest.mark.parametrize("question_id", ["DOC-24", "DOC-29", "DOC-30"])
async def test_exact_identifier_questions_find_their_source(
    conn: AsyncConnection, make_identity: Callable[..., Identity], question_id: str
) -> None:
    """Keyword search puts the source in the top three. Hybrid only promises the result list:
    here the vectors are fake and random, and rank fusion can let a random vector rank outvote
    a single exact keyword hit. With real embeddings the evaluation runner measures this."""
    q = question(question_id)
    sources = set(q["source_docs"])  # type: ignore[call-overload]
    asker = identity_for_role(str(q["role"]), make_identity)
    keyword = await search(conn, asker, str(q["question"]), "keyword")
    assert set(docs_of(keyword)[:3]) & sources, (question_id, docs_of(keyword))
    hybrid = await search(conn, asker, str(q["question"]), "hybrid")
    assert set(docs_of(hybrid)) & sources, (question_id, docs_of(hybrid))


async def test_a_document_number_in_the_question_finds_that_document(
    conn: AsyncConnection, make_identity: Callable[..., Identity]
) -> None:
    staff = identity_for_role("staff", make_identity)
    result = await search(conn, staff, "What does FIN-REIM-002 say?", "keyword")
    assert result.chunks[0].doc_code == "FIN-REIM-002"


# --- permissions ----------------------------------------------------------------------------


async def test_a_student_never_gets_an_hr_only_document_and_the_probe_notices(
    conn: AsyncConnection, make_identity: Callable[..., Identity]
) -> None:
    q = question("DOC-46")  # the instructor scoring rubric: restricted to HR
    assert q["source_docs"] == ["HR-REC-002"]
    student = identity_for_role("student", make_identity)
    hr = identity_for_role("hr", make_identity)
    for mode in ("keyword", "vector", "hybrid"):
        as_student = await search(conn, student, str(q["question"]), mode, probe=True)
        assert "HR-REC-002" not in docs_of(as_student), mode
    as_student = await search(conn, student, str(q["question"]), "hybrid", probe=True)
    assert as_student.diagnostics.restricted_keyword_hits > 0
    assert as_student.diagnostics.restricted_best_keyword_score

    as_hr = await search(conn, hr, str(q["question"]), "keyword", probe=True)
    assert "HR-REC-002" in docs_of(as_hr)
    assert as_hr.diagnostics.restricted_keyword_hits == 0 or all(
        c.doc_code != "HR-REC-002" for c in as_hr.chunks[:0]
    )


async def test_management_roles_alone_get_nothing(
    conn: AsyncConnection, make_identity: Callable[..., Identity]
) -> None:
    for role in ("Admin", "RAGETLAdmin"):
        who = identity_for_role(role, make_identity)
        for mode in ("keyword", "vector", "hybrid"):
            result = await search(conn, who, "What is the annual bonus formula?", mode, probe=True)
            assert result.chunks == [], (role, mode)
        assert (
            result.diagnostics.restricted_keyword_hits > 0
        )  # the content exists, they may not read it


def can_see(roles: frozenset[str], doc_code: str, version: str) -> bool:
    """Written from the documented access model, independent of the code under test."""
    readable = {
        "students-and-staff": {"student", "staff", "manager", "hr", "finance"},
        "all-staff": {"staff", "manager", "hr", "finance"},
        "staff": {"staff", "manager", "hr", "finance"},
        "managers": {"manager", "hr", "finance"},
        "finance-and-hr": {"hr", "finance"},
        "hr-only": {"hr"},
    }
    return bool(readable[MANIFEST[(doc_code, version)]["access"]] & roles)


async def test_no_question_ever_returns_a_chunk_the_asker_may_not_read(
    conn: AsyncConnection, make_identity: Callable[..., Identity]
) -> None:
    """Every question, asked by every role, in the modes that need no model."""
    roles = ["student", "staff", "manager", "hr", "finance", "Admin", "RAGETLAdmin"]
    vectors = {
        q["id"]: v
        for q, v in zip(
            QUESTIONS, await EMBEDDER.embed([str(q["question"]) for q in QUESTIONS]), strict=True
        )
    }
    checked = 0
    for role in roles:
        identity = identity_for_role(role, make_identity)
        for q in QUESTIONS:
            for mode in ("keyword", "vector", "hybrid"):
                result = await retrieve(
                    conn, identity, str(q["question"]), mode=mode, settings=SETTINGS,
                    embedder=EMBEDDER, query_vector=vectors[q["id"]],
                )  # fmt: skip
                for chunk in result.chunks:
                    assert can_see(identity.roles, chunk.doc_code, chunk.version), (
                        role,
                        q["id"],
                        mode,
                        chunk.doc_code,
                    )
                checked += 1
    assert checked == 7 * 54 * 3


# --- versions -------------------------------------------------------------------------------


async def test_both_versions_of_a_policy_come_back_labelled(
    conn: AsyncConnection, make_identity: Callable[..., Identity]
) -> None:
    q = question("DOC-43")
    staff = identity_for_role("staff", make_identity)
    # Keyword search ranks both versions in the top six. For hybrid, widen the final list: the
    # fake vectors are random, so only the labelling of what comes back is checked.
    keyword = await search(conn, staff, str(q["question"]), "keyword")
    assert {(c.version, c.status) for c in keyword.chunks if c.doc_code == "HR-REC-001"} == {
        ("1.0", "superseded"),
        ("2.1", "active"),
    }
    wide = SETTINGS.model_copy(
        update={"retrieval_final_k": 40, "retrieval_context_tokens": 100_000}
    )
    hybrid = await retrieve(
        conn, staff, str(q["question"]), mode="hybrid", settings=wide, embedder=EMBEDDER
    )
    assert {(c.version, c.status) for c in hybrid.chunks if c.doc_code == "HR-REC-001"} == {
        ("1.0", "superseded"),
        ("2.1", "active"),
    }


async def test_a_draft_is_never_returned(
    conn: AsyncConnection, ingested: tuple[str, str], make_identity: Callable[..., Identity]
) -> None:
    owner = create_async_engine(ingested[0])
    try:
        async with owner.begin() as c:
            await c.execute(
                text("UPDATE ai.documents SET status = 'draft' WHERE doc_code = 'FIN-TAX-008'")
            )
            await c.execute(
                text(
                    "UPDATE ai.document_chunks SET status = 'draft' WHERE doc_code = 'FIN-TAX-008'"
                )
            )
        hr = identity_for_role("hr", make_identity)
        for mode in ("keyword", "vector", "hybrid"):
            result = await search(conn, hr, "invoice tax ID requirements", mode)
            assert "FIN-TAX-008" not in docs_of(result), mode
    finally:
        async with owner.begin() as c:
            await c.execute(
                text("UPDATE ai.documents SET status = 'active' WHERE doc_code = 'FIN-TAX-008'")
            )
            await c.execute(
                text(
                    "UPDATE ai.document_chunks SET status = 'active' WHERE doc_code = 'FIN-TAX-008'"
                )
            )
        await owner.dispose()
