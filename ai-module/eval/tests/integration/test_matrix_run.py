"""文件：测试——对比实验矩阵（集成）
测什么：实验清单覆盖了检查清单里承诺的各项；估算统计入库次数和衍生内容的调用数；
实验在临时数据库上运行，并且结束后不留下任何东西。
"""

import json

import pytest
from starit_core.config import Settings
from starit_core.embeddings import FakeEmbeddingClient
from starit_core.testing import ScriptedChat
from starit_eval.dataset import load_questions
from starit_eval.matrix import EXPERIMENTS, MODES, Experiment, estimate, render, run_matrix

pytestmark = pytest.mark.integration

SETTINGS = Settings(_env_file=None, embedding_provider="fake")
DERIVED = json.dumps({"summary": "A short summary.", "questions": ["Who?", "When?", "How much?"]})


def test_the_matrix_covers_what_the_checklist_promised() -> None:
    names = {e.name for e in EXPERIMENTS}
    assert {"baseline", "chunk-300", "chunk-500", "chunk-800", "identifiers-off"} <= names
    assert {"derive-summary", "derive-questions", "derive-all"} <= names
    assert [e.ingest_key for e in EXPERIMENTS if e.name == "identifiers-off"] == [
        next(e.ingest_key for e in EXPERIMENTS if e.name == "baseline")
    ]  # a search-only change reuses the baseline's ingestion


def test_the_estimate_counts_ingestions_and_derive_calls() -> None:
    figures = estimate(SETTINGS, load_questions(), chunks=39, avg_tokens=290)
    assert figures["experiments"] == len(EXPERIMENTS)
    assert figures["ingests"] == 7  # identifiers-off shares the baseline's
    assert figures["derive_calls"] == 3 * 39


async def test_experiments_run_on_a_scratch_database_and_leave_nothing_behind() -> None:
    chosen = [
        Experiment("baseline", "baseline"),
        Experiment(
            "identifiers-off", "identifier weighting", {"retrieval_identifier_boost": False}
        ),
        Experiment("derive-all", "derived content", {"ingest_derive": "all"}),
    ]
    questions = load_questions()[:30]
    steps: list[str] = []
    results = await run_matrix(
        SETTINGS, FakeEmbeddingClient(), ScriptedChat(derive=DERIVED), questions, chosen,
        progress=steps.append,
    )  # fmt: skip
    assert [r.experiment.name for r in results] == ["baseline", "identifiers-off", "derive-all"]
    assert sum(1 for s in steps if s.startswith("ingesting")) == 2  # identifiers-off reuses
    baseline, off, derived = results
    assert baseline.derived_rows == 0 and off.derived_rows == 0 and derived.derived_rows > 0
    assert baseline.chunks == off.chunks and baseline.chunks > 0
    for result in results:
        assert set(result.overall) == set(MODES)
        assert all(
            0.0 <= v <= 1.0 for m in result.overall.values() for k, v in m.items() if k != "n"
        )
    text = render(results, {"embedding": "fake"}, "")
    assert "## hybrid" in text and "derive-all" in text and "BM25" in text

    import psycopg

    dsn = SETTINGS.migration_database_url.replace("+psycopg", "")
    with psycopg.connect(dsn) as conn:
        left = conn.execute(
            "SELECT count(*) FROM pg_database WHERE datname LIKE 'matrix_%'"
        ).fetchone()
    assert left == (0,)
