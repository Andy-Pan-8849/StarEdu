"""文件：测试——助手的权限（集成）
测什么：用真实检索在已入库的示例文档上，不同角色问同一个问题得到不同结局；
受限内容绝不出现在提示词、回答和引用里。
"""

import asyncio
import csv
import json
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from starit_core import retrieval
from starit_core.agent import messages
from starit_core.auth import Identity
from starit_core.config import Settings
from starit_core.embeddings import FakeEmbeddingClient
from starit_core.ingest.register import register_from_manifest
from starit_core.ingest.worker import run_worker
from starit_core.storage import InMemoryStorage
from starit_core.testing import Harness, ScriptedChat, generate_json, understand_json

pytestmark = pytest.mark.integration

SAMPLE_DATA = Path(__file__).resolve().parents[4] / "sample-data"
SETTINGS = Settings(_env_file=None, embedding_provider="fake")


def read_csv(path: Path) -> list[dict[str, str]]:
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


ACCOUNTS = read_csv(SAMPLE_DATA / "demo-accounts.csv")
QUESTIONS = [
    json.loads(x)
    for x in (SAMPLE_DATA / "eval" / "qa-set.jsonl").read_text(encoding="utf-8").splitlines()
]
MANIFEST = {
    (r["doc_id"], r["version"]): r for r in read_csv(SAMPLE_DATA / "documents" / "manifest.csv")
}
READABLE = {
    "students-and-staff": {"student", "staff", "manager", "hr", "finance"},
    "all-staff": {"staff", "manager", "hr", "finance"},
    "staff": {"staff", "manager", "hr", "finance"},
    "managers": {"manager", "hr", "finance"},
    "finance-and-hr": {"hr", "finance"},
    "hr-only": {"hr"},
}


def question(question_id: str) -> dict[str, Any]:
    return next(q for q in QUESTIONS if q["id"] == question_id)


def identity_for(role: str, make_identity: Callable[..., Identity]) -> Identity:
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
        await run_worker(engine, storage, FakeEmbeddingClient(), SETTINGS, once=True)
        await engine.dispose()

    asyncio.run(run())
    return scratch_urls


@pytest.fixture
async def engines(ingested: tuple[str, str]):  # type: ignore[no-untyped-def]
    owner, app = create_async_engine(ingested[0]), create_async_engine(ingested[1])
    yield owner, app
    await owner.dispose()
    await app.dispose()


def low_scores(messages_in: Sequence[Mapping[str, str]], _n: int) -> str:
    """A reranker that finds every passage irrelevant."""
    count = messages_in[1]["content"].count("\n[") + 1
    return json.dumps({"ranking": [{"id": i, "score": 1} for i in range(1, count + 1)]})


def scripted_reader(role: str, text_in: str) -> ScriptedChat:
    return ScriptedChat(
        understand=understand_json(query=text_in),
        generate=generate_json("Here is the answer [1].", citations=[1]),
        rerank=low_scores,
    )


async def ask(
    engines: tuple[AsyncEngine, AsyncEngine],
    identity: Identity,
    chat: ScriptedChat,
    text_in: str,
    mode: str,
) -> Any:
    harness = Harness(engines[0], engines[1], identity)
    runtime = await harness.runtime(chat, retrieval.retrieve, retrieval_mode=mode)
    result = await harness.ask(runtime, text_in)
    result.harness = harness  # type: ignore[attr-defined]
    return result


async def test_a_student_asking_about_an_hr_only_document_is_told_nothing_and_the_model_never_sees_it(
    engines: tuple[AsyncEngine, AsyncEngine], make_identity: Callable[..., Identity]
) -> None:
    q = question("DOC-46")  # the instructor scoring rubric: restricted to HR
    chat = ScriptedChat(
        understand=understand_json(query=q["question"]), rerank=low_scores
    )  # no generate script
    result = await ask(
        engines, identity_for("student", make_identity), chat, q["question"], "hybrid_rerank"
    )

    assert (result.end_state, result.end_reason) == ("no_permission", "restricted_document")
    assert result.content == messages.NOT_FOUND and result.citations == []
    assert "generate" not in chat.steps()  # it never got as far as writing an answer
    everything_the_model_saw = " ".join(m["content"] for _, calls in chat.calls for m in calls)
    assert "HR-REC-002" not in everything_the_model_saw
    filtered = (
        await result.harness.rows(
            "SELECT filtered_count FROM ai.audit_log WHERE action = 'chat.query'"
        )
    )[0][0]
    assert filtered > 0  # the audit trail records that something was hidden, not what


async def test_hr_asking_the_same_question_is_answered_from_that_document(
    engines: tuple[AsyncEngine, AsyncEngine], make_identity: Callable[..., Identity]
) -> None:
    q = question("DOC-46")
    chat = ScriptedChat(
        understand=understand_json(query=q["question"]),
        generate=generate_json("See the rubric [1].", citations=[1]),
    )
    result = await ask(engines, identity_for("hr", make_identity), chat, q["question"], "keyword")
    assert result.end_state == "answered"
    excerpts = chat.prompts("generate")[0]
    assert "HR-REC-002" in excerpts  # the document is among what the model was given
    assert result.citations[0]["doc_code"] == "HR-REC-002"


@pytest.mark.parametrize("role", ["Admin", "RAGETLAdmin"])
async def test_management_roles_get_nothing_to_read(
    engines: tuple[AsyncEngine, AsyncEngine], make_identity: Callable[..., Identity], role: str
) -> None:
    text_in = "What is the annual bonus formula and the rating multipliers?"
    chat = ScriptedChat(understand=understand_json(query=text_in), rewrite='{"query": "bonus"}')
    result = await ask(engines, identity_for(role, make_identity), chat, text_in, "hybrid_rerank")
    assert result.end_state in ("no_permission", "not_found")
    assert result.content == messages.NOT_FOUND and result.citations == []
    assert "generate" not in chat.steps()


async def test_citations_only_ever_name_documents_the_asker_may_read(
    engines: tuple[AsyncEngine, AsyncEngine], make_identity: Callable[..., Identity]
) -> None:
    checked = cited_total = 0
    for role in ("student", "staff", "manager", "hr", "finance"):
        identity = identity_for(role, make_identity)
        for q in QUESTIONS[:12]:
            chat = ScriptedChat(
                understand=understand_json(query=q["question"]),
                generate=generate_json("Answer [1][2].", citations=[1, 2]),
            )
            # Keyword mode: no reranker needed, and every returned chunk is a real match.
            result = await ask(engines, identity, chat, q["question"], "keyword")
            checked += 1
            for c in result.citations:
                cited_total += 1
                access = MANIFEST[(c["doc_code"], c["version"])]["access"]
                assert role in READABLE[access], (role, q["id"], c["doc_code"])
            # The excerpts the model was shown are held to the same rule.
            for _step, calls in chat.calls:
                for m in calls:
                    for (code, version), row in MANIFEST.items():
                        if f"] {code} v{version} (" in m["content"]:
                            assert role in READABLE[row["access"]], (role, q["id"], code)
    assert checked == 60 and cited_total > 0
