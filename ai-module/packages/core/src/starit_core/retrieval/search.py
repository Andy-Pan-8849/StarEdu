"""The entry point of retrieval. Every search needs an identity: there is no way to search
without saying who is asking."""

import time
from collections.abc import Sequence

from sqlalchemy.ext.asyncio import AsyncConnection

from starit_core.auth import Identity
from starit_core.config import Settings
from starit_core.embeddings import EmbeddingClient
from starit_core.retrieval.assemble import assemble
from starit_core.retrieval.fusion import rrf
from starit_core.retrieval.keyword import KeywordSearcher, TsRankKeywordSearcher
from starit_core.retrieval.models import Candidate, RetrievalDiagnostics, RetrievalResult
from starit_core.retrieval.probe import probe_restricted
from starit_core.retrieval.rerank import Reranker
from starit_core.retrieval.vector import vector_search

MODES = ("keyword", "vector", "hybrid", "hybrid_rerank")


async def retrieve(
    conn: AsyncConnection,
    identity: Identity,
    query: str,
    *,
    mode: str,
    settings: Settings,
    embedder: EmbeddingClient | None = None,
    reranker: Reranker | None = None,
    query_vector: Sequence[float] | None = None,
    keyword_searcher: KeywordSearcher | None = None,
    probe: bool = False,
) -> RetrievalResult:
    """Find the chunks of the documents `identity` may read that best answer `query`.

    `query_vector` lets a caller that already embedded the question (the evaluation runs one
    question in several modes) skip the second embedding call.
    """
    if mode not in MODES:
        raise ValueError(f"unknown retrieval mode {mode!r}; use one of {', '.join(MODES)}")
    if settings.keyword_searcher != "ts_rank_cd":
        raise ValueError(f"unknown keyword searcher {settings.keyword_searcher!r}")
    diagnostics = RetrievalDiagnostics(mode=mode)
    timings = diagnostics.timings_ms

    vector: Sequence[float] | None = query_vector
    if mode != "keyword" and vector is None:
        if embedder is None:
            raise ValueError(f"mode {mode!r} needs an embedding client or a query vector")
        started = time.perf_counter()
        vector = (await embedder.embed([query]))[0]
        timings["embed"] = _ms(started)

    keyword_hits: list[Candidate] = []
    if mode != "vector":
        started = time.perf_counter()
        searcher = keyword_searcher or TsRankKeywordSearcher(settings.retrieval_identifier_boost)
        keyword_hits = await searcher.search(conn, identity, query, settings.retrieval_keyword_k)
        timings["keyword"] = _ms(started)
    vector_hits: list[Candidate] = []
    if mode != "keyword":
        if vector is None:
            raise ValueError("a vector search needs the question's embedding")
        started = time.perf_counter()
        vector_hits = await vector_search(
            conn, identity, vector, _model(embedder, settings), settings.retrieval_vector_k
        )
        timings["vector"] = _ms(started)
    diagnostics.keyword_candidates = len(keyword_hits)
    diagnostics.vector_candidates = len(vector_hits)

    ordered = _order(mode, keyword_hits, vector_hits, settings.retrieval_rrf_k)

    if mode == "hybrid_rerank":
        if reranker is None:
            raise ValueError("mode 'hybrid_rerank' needs a reranker")
        pool = ordered[: settings.retrieval_rerank_in]
        started = time.perf_counter()
        outcome = await reranker.rerank(query, pool)
        timings["rerank"] = _ms(started)
        diagnostics.rerank_failed = outcome.failed
        diagnostics.rerank_error = outcome.error
        diagnostics.rerank_input_tokens = outcome.input_tokens
        diagnostics.rerank_output_tokens = outcome.output_tokens
        for index, score in outcome.scores.items():
            pool[index].rerank_score = score
        ordered = [pool[i] for i in outcome.order]

    chunks = assemble(
        ordered,
        final_k=settings.retrieval_final_k,
        budget_tokens=settings.retrieval_context_tokens,
    )

    if probe:
        started = time.perf_counter()
        found = await probe_restricted(conn, identity, query, vector, _model(embedder, settings))
        timings["probe"] = _ms(started)
        diagnostics.restricted_keyword_hits = found.restricted_keyword_hits
        diagnostics.restricted_best_keyword_score = found.restricted_best_keyword_score
        diagnostics.restricted_best_vector_similarity = found.restricted_best_vector_similarity
    return RetrievalResult(chunks=chunks, diagnostics=diagnostics)


def _order(
    mode: str, keyword_hits: list[Candidate], vector_hits: list[Candidate], rrf_k: int
) -> list[Candidate]:
    if mode == "keyword":
        return keyword_hits
    if mode == "vector":
        return vector_hits
    merged: dict[object, Candidate] = {}
    for candidate in keyword_hits + vector_hits:
        known = merged.setdefault(candidate.chunk_id, candidate)
        if candidate is not known:
            known.vector_rank = candidate.vector_rank
            known.vector_similarity = candidate.vector_similarity
            known.keyword_rank = known.keyword_rank or candidate.keyword_rank
            known.keyword_score = known.keyword_score or candidate.keyword_score
    scores = rrf([[c.chunk_id for c in keyword_hits], [c.chunk_id for c in vector_hits]], k=rrf_k)
    ordered = list(merged.values())
    for candidate in ordered:
        candidate.fused_score = scores[candidate.chunk_id]
    ordered.sort(key=lambda c: (-c.fused_score, str(c.chunk_id)))
    return ordered


def _model(embedder: EmbeddingClient | None, settings: Settings) -> str:
    return embedder.model if embedder is not None else settings.embedding_model


def _ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000, 2)
