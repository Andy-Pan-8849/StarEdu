"""文件：retrieval/search.py
作用：检索的入口 `retrieve`——把各步骤串起来，并记录链路和指标。
主要思想：任何检索都必须带 identity（谁在问），没有“不指定用户的检索”这条路。
流程（mode 决定走到哪一步）：
  keyword 关键词 / vector 向量 / hybrid 两者 RRF 融合 / hybrid_rerank 再加模型重排，
  最后用 assemble 在 token 预算内挑出放进提示词的块；probe=True 时额外统计被挡住的命中。
四种 mode 同时是评测的对比维度。
"""

import time
from collections.abc import Awaitable, Callable, Sequence
from functools import wraps

from sqlalchemy.ext.asyncio import AsyncConnection

from starit_core import telemetry
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


def _traced[**P](
    fn: Callable[P, Awaitable[RetrievalResult]],
) -> Callable[P, Awaitable[RetrievalResult]]:
    """装饰器：给检索加一个链路 span 和指标；只记录数字和 mode，不记录问题或文本内容。"""

    @wraps(fn)
    async def wrapper(*args: P.args, **kwargs: P.kwargs) -> RetrievalResult:
        mode = str(kwargs.get("mode", ""))
        tele = telemetry.current()
        started = time.perf_counter()
        with telemetry.span("retrieval.search", {"retrieval.mode": mode}) as active:
            result = await fn(*args, **kwargs)
            d = result.diagnostics
            active.set_attribute("retrieval.keyword_candidates", d.keyword_candidates)
            active.set_attribute("retrieval.vector_candidates", d.vector_candidates)
            active.set_attribute("retrieval.returned", len(result.chunks))
            active.set_attribute("retrieval.restricted_hits", d.restricted_keyword_hits)
            active.set_attribute("retrieval.rerank_failed", d.rerank_failed)
        tele.retrievals.add(1, {"mode": mode})
        tele.retrieval_duration.record(time.perf_counter() - started, {"mode": mode})
        if d.restricted_keyword_hits:
            tele.retrieval_restricted.add(d.restricted_keyword_hits, {"mode": mode})
        return result

    return wrapper


@_traced
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
    """找出 `identity` 有权读的、最能回答 `query` 的文本块。

    参数：
      conn：数据库连接；identity：提问者身份；query：用户问题。
      mode：MODES 之一（keyword / vector / hybrid / hybrid_rerank）。
      settings：配置（各阶段的 k、token 预算等）。
      embedder：嵌入客户端（除 keyword 外需要，除非已给 query_vector）。
      reranker：重排器（hybrid_rerank 需要）。
      query_vector：调用方已经算好的问题向量；评测同一个问题跑多种 mode 时可省掉重复嵌入。
      keyword_searcher：替换关键词检索实现（评测对比用）。
      probe：是否统计被权限挡住的命中（写入 diagnostics）。
    返回：RetrievalResult。mode 或配置不合法时抛 ValueError。
    """
    if mode not in MODES:
        raise ValueError(f"unknown retrieval mode {mode!r}; use one of {', '.join(MODES)}")
    if settings.keyword_searcher != "ts_rank_cd":
        raise ValueError(f"unknown keyword searcher {settings.keyword_searcher!r}")
    diagnostics = RetrievalDiagnostics(mode=mode)
    timings = diagnostics.timings_ms

    # 第 0 步：需要向量的模式先把问题嵌入（调用方给了就不再算）
    vector: Sequence[float] | None = query_vector
    if mode != "keyword" and vector is None:
        if embedder is None:
            raise ValueError(f"mode {mode!r} needs an embedding client or a query vector")
        started = time.perf_counter()
        vector = (await embedder.embed([query]))[0]
        timings["embed"] = _ms(started)

    # 第 1 步：关键词检索（vector 模式跳过）
    keyword_hits: list[Candidate] = []
    if mode != "vector":
        started = time.perf_counter()
        searcher = keyword_searcher or TsRankKeywordSearcher(settings.retrieval_identifier_boost)
        keyword_hits = await searcher.search(conn, identity, query, settings.retrieval_keyword_k)
        timings["keyword"] = _ms(started)
    # 第 2 步：向量检索（keyword 模式跳过）
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

    # 第 3 步：融合排序（hybrid 系列用 RRF）
    ordered = _order(mode, keyword_hits, vector_hits, settings.retrieval_rrf_k)

    # 第 4 步：只对融合后的前 N 个做模型重排；失败则保留融合顺序
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

    # 第 5 步：在 token 预算内挑出放进提示词的块
    chunks = assemble(
        ordered,
        final_k=settings.retrieval_final_k,
        budget_tokens=settings.retrieval_context_tokens,
    )

    # 第 6 步（可选）：统计被权限挡住的强相关内容，仅数字，用于审计
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
    """把关键词结果和向量结果排成一份。

    keyword / vector 模式直接用对应结果；hybrid 系列先按块 ID 合并两边的名次和分数，
    再用 RRF 融合分数排序（分数相同按 ID 排，保证结果可复现）。
    """
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
