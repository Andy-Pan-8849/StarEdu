"""文件：测试——答案评测的完整流程（集成）
测什么：在已入库的示例文档上，用脚本化的模型：题目被提问、判分、汇总并存入数据库；
  答错的题会被判为失败。
"""

import asyncio
from collections.abc import AsyncIterator

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from starit_core.config import Settings
from starit_core.embeddings import FakeEmbeddingClient
from starit_core.ingest.register import register_from_manifest
from starit_core.ingest.worker import run_worker
from starit_core.storage import InMemoryStorage
from starit_core.testing import ScriptedChat, generate_json, understand_json
from starit_eval.answers import UsageChat, run_answers, store, summarize
from starit_eval.dataset import SAMPLE_DATA, Question, load_identities

pytestmark = pytest.mark.integration

SETTINGS = Settings(_env_file=None, embedding_provider="fake", retrieval_mode="keyword")


@pytest.fixture(scope="module")
def ingested(scratch_urls: tuple[str, str]) -> tuple[str, str]:
    async def run() -> None:
        engine = create_async_engine(scratch_urls[1])
        storage = InMemoryStorage()
        await register_from_manifest(engine, storage, SAMPLE_DATA / "documents")
        await run_worker(engine, storage, FakeEmbeddingClient(), SETTINGS, once=True)
        await engine.dispose()

    asyncio.run(run())
    return scratch_urls


@pytest.fixture
async def engine(ingested: tuple[str, str]) -> AsyncIterator[AsyncEngine]:
    engine = create_async_engine(ingested[1])
    yield engine
    await engine.dispose()


def q(
    ident: str,
    role: str,
    text_: str,
    expected: str,
    docs: tuple[str, ...],
    answer: bool,
    facts: tuple[str, ...] = (),
) -> Question:
    return Question(ident, "single", role, text_, expected, docs, answer, facts)


async def test_questions_are_asked_graded_summarised_and_stored(engine: AsyncEngine) -> None:
    questions = [
        q(
            "T-1",
            "staff",
            "How long is a job offer valid?",
            "7 calendar days.",
            ("HR-REC-001",),
            True,
            ("7",),
        ),
        q(
            "T-2",
            "student",
            "What is the pass threshold for instructor candidates?",
            "restricted",
            ("HR-REC-002",),
            False,
        ),
        q(
            "T-3",
            "staff",
            "How long is a job offer valid, in words?",
            "seven days",
            ("HR-REC-001",),
            True,
        ),
    ]
    chat = ScriptedChat(
        understand=[
            understand_json("doc_qa", "job offer valid"),
            understand_json("doc_qa", "pass threshold instructor candidates score"),
            understand_json("doc_qa", "job offer valid"),
        ],
        generate=[
            generate_json("An offer is valid for 7 calendar days [1].", citations=[1]),
            generate_json("", sufficient=False, citations=[]),
            generate_json("It is valid for seven days [1].", citations=[1]),
        ],
        judge='{"verdict": "correct", "reason": "same"}',
    )
    run = await run_answers(
        engine, SETTINGS, FakeEmbeddingClient(), UsageChat(chat), load_identities(), questions
    )
    by_id = {r.question.id: r for r in run.results}
    assert by_id["T-1"].passed and by_id["T-1"].method == "facts" and by_id["T-1"].cites_source
    assert by_id["T-2"].passed and by_id["T-2"].method == "refusal"
    assert by_id["T-2"].end_state in ("not_found", "no_permission")
    assert by_id["T-3"].passed and by_id["T-3"].method == "judge"
    assert all(r.legal_end for r in run.results)
    assert chat.steps().count("judge") == 1  # only the question without facts is judged

    summary = summarize(run)
    assert summary["passed"] == 3 and summary["graded_by"] == {"facts": 1, "judge": 1, "refusal": 1}

    run_id = await store(engine, run, summary, "abc1234", "test")
    async with engine.connect() as conn:
        rows = (
            await conn.execute(
                text("SELECT count(*) FROM ai.eval_results WHERE run_id = :r"), {"r": run_id}
            )
        ).scalar()
        stored = (
            await conn.execute(
                text("SELECT summary->>'passed' FROM ai.eval_runs WHERE id = :r"), {"r": run_id}
            )
        ).scalar()
    assert (rows, stored) == (3, "3")


async def test_a_wrong_answer_fails(engine: AsyncEngine) -> None:
    questions = [
        q(
            "T-4",
            "staff",
            "How long is a job offer valid?",
            "7 calendar days.",
            ("HR-REC-001",),
            True,
            ("7",),
        ),
    ]
    chat = ScriptedChat(
        understand=understand_json("doc_qa", "job offer valid"),
        generate=generate_json("An offer is valid for 5 calendar days [1].", citations=[1]),
    )
    run = await run_answers(
        engine,
        SETTINGS,
        FakeEmbeddingClient(),
        UsageChat(chat),
        load_identities(),
        questions,
    )
    assert not run.results[0].passed and "lacks '7'" in run.results[0].problems[0]
