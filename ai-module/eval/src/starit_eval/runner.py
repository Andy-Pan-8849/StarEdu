"""Run the questions through retrieval and collect what the metrics and the report need."""

import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncEngine
from starit_core.auth import Identity
from starit_core.config import Settings
from starit_core.embeddings import EmbeddingClient
from starit_core.ingest.tokens import count_tokens
from starit_core.retrieval import retrieve
from starit_core.retrieval.models import Candidate
from starit_core.retrieval.rerank import Reranker

from starit_eval.dataset import ALL_ROLES, Question
from starit_eval.leak import may_read

SWEEP_MODES = ("keyword", "vector", "hybrid")  # modes that need no model besides the embedder


@dataclass
class QuestionRun:
    question: Question
    mode: str
    asker: str
    doc_codes: list[str]
    chunk_ids: list[str]
    top_score: float | None
    latency_ms: float
    rerank_failed: bool
    violations: list[str]  # documents returned that the asker may not read: must be empty
    restricted_keyword_hits: int


@dataclass
class ModeRun:
    mode: str
    runs: list[QuestionRun] = field(default_factory=list)
    rerank_input_tokens: int = 0
    rerank_output_tokens: int = 0
    rerank_failures: int = 0


@dataclass
class SweepResult:
    checked: int = 0
    violations: list[tuple[str, str, str, str]] = field(
        default_factory=list
    )  # role, question, mode, document


async def embed_questions(
    embedder: EmbeddingClient, questions: Sequence[Question], batch_size: int = 64
) -> tuple[dict[str, list[float]], int]:
    """Embed each question once, however many modes and roles ask it. Returns (vectors, tokens)."""
    vectors: dict[str, list[float]] = {}
    for start in range(0, len(questions), batch_size):
        batch = questions[start : start + batch_size]
        for question, vector in zip(
            batch, await embedder.embed([q.question for q in batch]), strict=True
        ):
            vectors[question.id] = vector
    return vectors, sum(count_tokens(q.question) for q in questions)


def _top_score(chunks: Sequence[Candidate], mode: str) -> float | None:
    if not chunks:
        return None
    first = chunks[0]
    if first.rerank_score is not None:
        return first.rerank_score
    if mode == "keyword":
        return first.keyword_score
    if mode == "vector":
        return first.vector_similarity
    return first.fused_score


def _violations(
    chunks: Sequence[Candidate],
    identity: Identity,
    manifest: Mapping[tuple[str, str], Mapping[str, str]],
) -> list[str]:
    return [
        f"{c.doc_code} v{c.version}"
        for c in chunks
        if not may_read(identity.roles, c.doc_code, c.version, manifest)
    ]


async def evaluate_mode(
    engine: AsyncEngine,
    settings: Settings,
    embedder: EmbeddingClient,
    reranker: Reranker | None,
    questions: Sequence[Question],
    identities: Mapping[str, Identity],
    manifest: Mapping[tuple[str, str], Mapping[str, str]],
    vectors: Mapping[str, list[float]],
    mode: str,
    *,
    probe: bool = True,
) -> ModeRun:
    """Every question, asked as the role that the evaluation set names."""
    result = ModeRun(mode=mode)
    async with engine.connect() as conn:
        for question in questions:
            identity = identities[question.role]
            started = time.perf_counter()
            found = await retrieve(
                conn,
                identity,
                question.question,
                mode=mode,
                settings=settings,
                embedder=embedder,
                reranker=reranker,
                query_vector=vectors[question.id],
                probe=probe,
            )
            latency = (time.perf_counter() - started) * 1000
            diagnostics = found.diagnostics
            result.rerank_input_tokens += diagnostics.rerank_input_tokens
            result.rerank_output_tokens += diagnostics.rerank_output_tokens
            result.rerank_failures += int(diagnostics.rerank_failed)
            result.runs.append(
                QuestionRun(
                    question=question,
                    mode=mode,
                    asker=identity.user_id,
                    doc_codes=[c.doc_code for c in found.chunks],
                    chunk_ids=[str(c.chunk_id) for c in found.chunks],
                    top_score=_top_score(found.chunks, mode),
                    latency_ms=latency,
                    rerank_failed=diagnostics.rerank_failed,
                    violations=_violations(found.chunks, identity, manifest),
                    restricted_keyword_hits=diagnostics.restricted_keyword_hits,
                )
            )
    return result


async def leak_sweep(
    engine: AsyncEngine,
    settings: Settings,
    embedder: EmbeddingClient,
    questions: Sequence[Question],
    identities: Mapping[str, Identity],
    manifest: Mapping[tuple[str, str], Mapping[str, str]],
    vectors: Mapping[str, list[float]],
) -> SweepResult:
    """Every question, asked by every role, in each mode that needs no model: nothing returned
    may be a document the asker is not allowed to read."""
    sweep = SweepResult()
    async with engine.connect() as conn:
        for role in ALL_ROLES:
            identity = identities[role]
            for question in questions:
                for mode in SWEEP_MODES:
                    found = await retrieve(
                        conn,
                        identity,
                        question.question,
                        mode=mode,
                        settings=settings,
                        embedder=embedder,
                        query_vector=vectors[question.id],
                    )
                    sweep.checked += 1
                    for violation in _violations(found.chunks, identity, manifest):
                        sweep.violations.append((role, question.id, mode, violation))
    return sweep
