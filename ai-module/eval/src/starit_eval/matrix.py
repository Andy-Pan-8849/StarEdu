"""The experiment matrix: how retrieval changes when one thing about ingestion or search changes.

Each experiment re-ingests the sample documents into a scratch database (the development database
is never touched), asks every answerable question in the three modes that need no reranking
model, and records hit@k and MRR. Reranking is left out on purpose: it is measured by the full
run, and it is the expensive part. Experiments that only change search (identifier weighting)
reuse the ingestion of the baseline.
"""

import asyncio
import os
import subprocess
import sys
import uuid
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import psycopg
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from starit_core.config import Settings
from starit_core.embeddings import EmbeddingClient
from starit_core.ingest.register import register_from_manifest
from starit_core.ingest.worker import run_worker
from starit_core.llm import ChatClient
from starit_core.storage import InMemoryStorage

from starit_eval import metrics
from starit_eval.dataset import AI_MODULE, SAMPLE_DATA, Question, load_identities, load_manifest
from starit_eval.report import scored
from starit_eval.runner import embed_questions, evaluate_mode

MODES = ("keyword", "vector", "hybrid")


@dataclass(frozen=True)
class Experiment:
    name: str
    group: str
    overrides: dict[str, Any] = field(default_factory=dict)

    @property
    def ingest_key(self) -> tuple[Any, ...]:
        return (
            self.overrides.get("chunk_target_tokens"),
            self.overrides.get("chunk_max_tokens"),
            self.overrides.get("ingest_derive", "none"),
        )


def _chunks(target: int) -> dict[str, Any]:
    return {"chunk_target_tokens": target, "chunk_max_tokens": int(target * 1.25)}


EXPERIMENTS: tuple[Experiment, ...] = (
    Experiment("baseline", "baseline"),
    Experiment("chunk-300", "chunk size", _chunks(300)),
    Experiment("chunk-500", "chunk size", _chunks(500)),
    Experiment("chunk-800", "chunk size", _chunks(800)),
    Experiment("identifiers-off", "identifier weighting", {"retrieval_identifier_boost": False}),
    Experiment("derive-summary", "derived content", {"ingest_derive": "summary"}),
    Experiment("derive-questions", "derived content", {"ingest_derive": "questions"}),
    Experiment("derive-all", "derived content", {"ingest_derive": "all"}),
)


@dataclass
class ExperimentResult:
    experiment: Experiment
    chunks: int
    avg_tokens: int
    overall: dict[str, dict[str, float]]  # mode -> hit@1, hit@3, hit@6, mrr
    by_type: dict[str, dict[str, float]]  # type -> hybrid mrr, for the types that matter here
    derived_rows: int = 0


def estimate(
    settings: Settings, questions: Sequence[Question], chunks: int, avg_tokens: int
) -> dict[str, Any]:
    """Upper bounds: embedding tokens (questions and every ingestion) and derive-model calls."""
    ingests = len({e.ingest_key for e in EXPERIMENTS})
    derive_runs = len({e.ingest_key for e in EXPERIMENTS if e.ingest_key[2] != "none"})
    embedding_tokens = (
        20 * len(questions) + ingests * chunks * (avg_tokens + 60) + derive_runs * chunks * 150
    )
    derive_calls = derive_runs * chunks
    return {
        "experiments": len(EXPERIMENTS),
        "ingests": ingests,
        "embedding_tokens": embedding_tokens,
        "derive_calls": derive_calls,
        "derive_input_tokens": derive_calls * (avg_tokens + 200),
        "derive_output_tokens": derive_calls * 150,
    }


@asynccontextmanager
async def scratch_database(settings: Settings) -> AsyncIterator[str]:
    """A fresh, migrated database next to the development one; dropped afterwards.
    Yields the URL of the application role on it."""
    owner = make_url(settings.migration_database_url)
    admin_dsn = owner.set(drivername="postgresql", database="postgres").render_as_string(False)
    name = f"matrix_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(admin_dsn, autocommit=True, connect_timeout=5) as admin:
        admin.execute(f'CREATE DATABASE "{name}"')
    try:
        await asyncio.to_thread(
            subprocess.run,
            [sys.executable, "-m", "alembic", "upgrade", "head"],
            cwd=AI_MODULE,
            env={
                **os.environ,
                "STARIT_MIGRATION_DATABASE_URL": owner.set(database=name).render_as_string(False),
            },
            check=True,
            capture_output=True,
            text=True,
        )
        yield make_url(settings.database_url).set(database=name).render_as_string(False)
    finally:
        with psycopg.connect(admin_dsn, autocommit=True) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


async def _ingest(
    engine: AsyncEngine,
    settings: Settings,
    embedder: EmbeddingClient,
    chat: ChatClient,
    storage: InMemoryStorage,
) -> None:
    async with engine.begin() as conn:
        await conn.execute(text("DELETE FROM ai.documents"))  # chunks and jobs follow (cascade)
    await register_from_manifest(engine, storage, SAMPLE_DATA / "documents")
    await run_worker(engine, storage, embedder, settings, once=True, chat=chat)
    async with engine.connect() as conn:
        failed = (
            await conn.execute(
                text("SELECT count(*) FROM ai.documents WHERE ingest_status <> 'ready'")
            )
        ).scalar_one()
    if failed:
        raise RuntimeError(f"{failed} document(s) did not finish ingesting")


async def run_matrix(
    base: Settings,
    embedder: EmbeddingClient,
    chat: ChatClient,
    questions: Sequence[Question],
    experiments: Sequence[Experiment] = EXPERIMENTS,
    progress: Any = None,
) -> list[ExperimentResult]:
    identities, manifest = load_identities(), load_manifest()
    results: list[ExperimentResult] = []
    vectors, _ = await embed_questions(embedder, questions, base.embedding_batch_size)
    async with scratch_database(base) as url:
        engine = create_async_engine(url)
        storage = InMemoryStorage()
        ingested: tuple[Any, ...] | None = None
        try:
            for index, experiment in enumerate(experiments, start=1):
                settings = base.model_copy(update=experiment.overrides)
                if experiment.ingest_key != ingested:
                    if progress:
                        progress(f"ingesting for {experiment.name}")
                    await _ingest(engine, settings, embedder, chat, storage)
                    ingested = experiment.ingest_key
                if progress:
                    progress(f"asking for {experiment.name} ({index}/{len(experiments)})")
                overall: dict[str, dict[str, float]] = {}
                by_type: dict[str, dict[str, float]] = {}
                for mode in MODES:
                    run = await evaluate_mode(
                        engine, settings, embedder, None, questions, identities, manifest,
                        vectors, mode, probe=False,
                    )  # fmt: skip
                    items = scored(run.runs)
                    summary = metrics.summarize(items)
                    overall[mode] = {
                        "n": summary.n,
                        "hit@1": round(summary.hit1, 4),
                        "hit@3": round(summary.hit3, 4),
                        "hit@6": round(summary.hit6, 4),
                        "mrr": round(summary.mrr, 4),
                    }
                    if mode == "hybrid":
                        by_type = {
                            t: {"n": s.n, "hit@1": round(s.hit1, 4), "mrr": round(s.mrr, 4)}
                            for t, s in metrics.summarize_by_type(items).items()
                        }
                async with engine.connect() as conn:
                    chunk_count, avg = (
                        await conn.execute(
                            text(
                                "SELECT count(*), coalesce(round(avg(token_count)), 0) FROM ai.document_chunks"  # noqa: E501
                            )
                        )
                    ).one()
                    derived = (
                        await conn.execute(text("SELECT count(*) FROM ai.chunk_derived"))
                    ).scalar_one()
                results.append(
                    ExperimentResult(
                        experiment, int(chunk_count), int(avg), overall, by_type, int(derived)
                    )
                )
        finally:
            await engine.dispose()
    return results


def render(results: Sequence[ExperimentResult], models: dict[str, str], estimate_note: str) -> str:
    date = datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        f"# 实验矩阵（{date}）",
        "",
        "模型：" + "，".join(f"{k} `{v}`" for k, v in models.items()) + "。" + estimate_note,
        "",
        "每个实验把样例文档重新入库到一个临时数据库（开发库不受影响），对所有有来源文档的可回答题"
        "在 keyword / vector / hybrid 三种模式下检索（不含重排，重排在完整评测里测）。"
        "hit@k：来源文档在前 k 个结果中的比例；MRR：来源文档的排名倒数的平均。",
        "",
    ]
    for mode in MODES:
        lines += [
            f"## {mode}",
            "",
            "| 实验 | 分组 | 块数 | 平均 token | n | hit@1 | hit@3 | hit@6 | MRR |",
            "|---|---|---|---|---|---|---|---|---|",
        ]
        for r in results:
            o = r.overall[mode]
            lines.append(
                f"| {r.experiment.name} | {r.experiment.group} | {r.chunks} | {r.avg_tokens} | {o['n']:.0f} "  # noqa: E501
                f"| {o['hit@1']} | {o['hit@3']} | {o['hit@6']} | {o['mrr']} |"
            )
        lines.append("")
    types = sorted({t for r in results for t in r.by_type})
    lines += [
        "## hybrid：按题型的 MRR（n 很小，只看方向）",
        "",
        "| 实验 | " + " | ".join(f"{t}" for t in types) + " |",
        "|---|" + "---|" * len(types),
    ]
    for r in results:
        cells = [
            f"{r.by_type[t]['mrr']} (n={r.by_type[t]['n']:.0f})" if t in r.by_type else "–"
            for t in types
        ]
        lines.append(f"| {r.experiment.name} | " + " | ".join(cells) + " |")
    lines += [
        "",
        "## 不在这个矩阵里的",
        "",
        "- **Rerank 实现**：只有 LLM 列表式重排，没有接入专用重排接口，所以没有可比较的对象。",
        "- **关键词排序 `ts_rank_cd` 与 BM25 扩展**：BM25 扩展没有安装也没有验证过，第一阶段不引入。",  # noqa: E501
        "- 派生内容只加强**向量**一侧（它被加进被嵌入的文本），关键词一侧不使用它，所以它对 keyword 模式没有影响。",  # noqa: E501
        "",
    ]
    return "\n".join(lines) + "\n"


def write(
    out_dir: Path, results: Sequence[ExperimentResult], models: dict[str, str], note: str
) -> Path:
    import json

    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M")
    path = out_dir / f"matrix-{stamp}.md"
    path.write_text(render(results, models, note), encoding="utf-8")
    path.with_suffix(".json").write_text(
        json.dumps(
            [
                {
                    "experiment": r.experiment.name,
                    "group": r.experiment.group,
                    "overrides": r.experiment.overrides,
                    "chunks": r.chunks,
                    "avg_tokens": r.avg_tokens,
                    "derived_rows": r.derived_rows,
                    "overall": r.overall,
                    "by_type": r.by_type,
                }
                for r in results
            ],
            indent=2,
        ),
        encoding="utf-8",
    )
    return path
