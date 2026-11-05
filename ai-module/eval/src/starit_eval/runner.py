"""文件：runner.py
作用：把题目送进检索，收集指标和报告需要的数据。
内容：
  - embed_questions：每道题只嵌入一次，多种模式、多个角色共用同一个向量，省钱；
  - evaluate_mode：在某种检索模式下，按题目指定的角色提问，记录返回的文档、分数、耗时，
    并用独立的 leak.may_read 检查有没有越权；
  - leak_sweep：越权扫描——每个角色问每道题，用不需要额外模型的三种模式各查一次，
    返回里不应出现任何无权读的文档（越权必须为 0）。
"""

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

# 越权扫描用的模式：除嵌入模型外不需要别的模型，所以几乎不花钱
SWEEP_MODES = ("keyword", "vector", "hybrid")  # modes that need no model besides the embedder


@dataclass
class QuestionRun:
    """一道题在一种模式下的检索记录；violations 是越权返回的文档，必须为空。"""

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
    """一种检索模式跑完全部题的汇总，含重排用掉的 token 和失败次数。"""

    mode: str
    runs: list[QuestionRun] = field(default_factory=list)
    rerank_input_tokens: int = 0
    rerank_output_tokens: int = 0
    rerank_failures: int = 0


@dataclass
class SweepResult:
    """越权扫描的结果：检查次数，以及每个违规的（角色, 题号, 模式, 文档）。"""

    checked: int = 0
    violations: list[tuple[str, str, str, str]] = field(
        default_factory=list
    )  # role, question, mode, document


async def embed_questions(
    embedder: EmbeddingClient, questions: Sequence[Question], batch_size: int = 64
) -> tuple[dict[str, list[float]], int]:
    """批量嵌入所有题目，返回 ({题号: 向量}, 用掉的 token 数)。"""
    vectors: dict[str, list[float]] = {}
    for start in range(0, len(questions), batch_size):
        batch = questions[start : start + batch_size]
        for question, vector in zip(
            batch, await embedder.embed([q.question for q in batch]), strict=True
        ):
            vectors[question.id] = vector
    return vectors, sum(count_tokens(q.question) for q in questions)


def _top_score(chunks: Sequence[Candidate], mode: str) -> float | None:
    """取第一名的分数：有重排分用重排分，否则按模式取关键词分/向量相似度/融合分。用来画“分数 vs
    能否回答”的参考线。
    """
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
    """返回结果里提问者无权读的文档（用独立实现判断）。"""
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
    """以题目指定的角色，在某种模式下依次检索每道题，返回 ModeRun。probe
    为真时同时统计被权限挡住的命中。
    """
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
    """越权扫描：每个角色 × 每道题 × 三种模式，任何一份无权读的文档出现在结果里都记为违规。"""
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
