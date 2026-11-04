import csv
import io
import json

import pytest
from starit_core.llm import ChatError, ChatResult
from starit_core.testing import ScriptedChat
from starit_eval.answers import (
    AnswerResult,
    AnswersRun,
    UsageChat,
    end_state_is_legal,
    grade,
    judge_answer,
    missing_facts,
    normalize,
    percentile,
    review_csv,
    review_sample,
    summarize,
)
from starit_eval.dataset import Question


def question(
    *,
    facts: tuple[str, ...] = (),
    answer: bool = True,
    docs: tuple[str, ...] = ("HR-REC-001",),
    kind: str = "single",
    role: str = "staff",
    ident: str = "DOC-99",
) -> Question:
    return Question(ident, kind, role, "q?", "reference", docs, answer, facts)


@pytest.mark.parametrize(
    ("facts", "answer", "absent"),
    [
        (["3,000"], "The bonus is CNY 3000.", []),
        (["3000"], "The bonus is CNY 3,000.", []),
        (["5"], "There are 15 days.", ["5"]),
        (["5"], "About 5.5 days.", ["5"]),
        (["5"], "Five days, that is 5.", []),
        (["I4"], "Needed for promotion to i4.", []),
        (["02:00"], "Sunday 02:00 to 04:00", []),
        (["finance-help@starit.example"], "Write to finance-help@starit.example.", []),
        (["zero", "20"], "A score of zero; 20 percent otherwise", []),
        (["zero", "20"], "A score of zero", ["20"]),
        (["VPN"], "use the student vpn", []),
    ],
)
def test_facts_must_all_be_in_the_answer(facts: list[str], answer: str, absent: list[str]) -> None:
    assert missing_facts(facts, answer) == absent


def test_normalize_removes_thousands_separators_only_between_digits() -> None:
    assert normalize("CNY 3,000, paid") == "cny 3000, paid"


@pytest.mark.parametrize(
    ("state", "reason", "legal"),
    [
        ("answered", None, True),
        ("answered", "x", False),
        ("need_clarification", "ambiguous_question", True),
        ("no_permission", "restricted_document", True),
        ("no_permission", "restricted_data", True),
        ("not_found", "no_matching_rows", True),
        ("not_found", "restricted_data", False),
        ("refused", "write_not_enabled", True),
        ("refused", "not_available_yet", False),
        ("error", "llm_error", True),
        ("error", None, False),
        ("weird", None, False),
    ],
)
def test_legal_end_states(state: str, reason: str | None, legal: bool) -> None:
    assert end_state_is_legal(state, reason) is legal


async def never(_q: Question, _a: str) -> tuple[bool | None, str]:
    raise AssertionError("the judge must not be asked")


async def test_a_refusal_passes_only_in_a_refusal_state_without_citing_the_document() -> None:
    must_refuse = question(answer=False, docs=("HR-REC-002",), kind="access")
    ok = await grade(must_refuse, "no_permission", "restricted_document", "not found", [], never)
    assert ok[0] and ok[1] == "refusal"
    assert not (await grade(must_refuse, "answered", None, "75 points", [], never))[0]
    leaked = await grade(
        must_refuse, "not_found", "no_relevant_documents", "x", ["HR-REC-002"], never
    )
    assert not leaked[0] and "cites the restricted document" in leaked[2][0]


async def test_an_answerable_question_must_be_answered_then_facts_decide() -> None:
    q = question(facts=("7",))
    assert (await grade(q, "answered", None, "Valid for 7 days [1]", ["HR-REC-001"], never))[0]
    wrong = await grade(q, "answered", None, "Valid for 5 days [1]", ["HR-REC-001"], never)
    assert not wrong[0] and "lacks '7'" in wrong[2][0]
    clarify = await grade(q, "need_clarification", "ambiguous_question", "Which?", [], never)
    assert not clarify[0] and "ended as need_clarification" in clarify[2][0]


async def test_without_facts_the_judge_decides() -> None:
    q = question()

    async def yes(_q: Question, _a: str) -> tuple[bool | None, str]:
        return True, "same facts"

    async def no(_q: Question, _a: str) -> tuple[bool | None, str]:
        return False, "wrong figure"

    async def unsure(_q: Question, _a: str) -> tuple[bool | None, str]:
        return None, "unreadable"

    assert (await grade(q, "answered", None, "a", [], yes))[:2] == (True, "judge")
    assert not (await grade(q, "answered", None, "a", [], no))[0]
    unsure_result = await grade(q, "answered", None, "a", [], unsure)
    assert not unsure_result[0] and unsure_result[2] == ["the judge gave no verdict"]


@pytest.mark.parametrize(
    ("reply", "verdict"),
    [
        ('{"verdict": "correct", "reason": "ok"}', True),
        ('{"verdict": "Incorrect", "reason": "no"}', False),
        ('{"verdict": "maybe"}', None),
        ("not json", None),
        (ChatError("down"), None),
    ],
)
async def test_judge_answer_reads_the_verdict(reply: str | Exception, verdict: bool | None) -> None:
    chat = ScriptedChat(judge=reply)
    result, _ = await judge_answer(chat, "m", "q", "ref", "ans")
    assert result is verdict
    assert "Reference answer: ref" in chat.prompts("judge")[0]


def result(ident: str, passed: bool, seconds: float = 1.0, **kw: object) -> AnswerResult:
    q = question(ident=ident, **kw)  # type: ignore[arg-type]
    return AnswerResult(
        q,
        "answered",
        None,
        f"answer {ident}",
        ["HR-REC-001"],
        passed,
        "facts",
        [],
        True,
        True,
        seconds=seconds,
    )


def test_the_review_sample_is_a_reproducible_fifth() -> None:
    results = [result(f"DOC-{i:03d}", i % 2 == 0) for i in range(50)]
    first, second = review_sample(results), review_sample(results)
    assert [r.question.id for r in first] == [r.question.id for r in second]
    assert len(first) == 10
    rows = list(csv.DictReader(io.StringIO(review_csv(results))))
    assert len(rows) == 10 and rows[0]["human_verdict"] == "" and "auto_verdict" in rows[0]


def test_percentile_and_summary() -> None:
    assert percentile([1, 2, 3, 4, 5], 0.5) == 3 and percentile([], 0.5) == 0.0
    run = AnswersRun(
        results=[
            result("DOC-1", True, 1.0, kind="single"),
            result("DOC-2", False, 3.0, kind="version", role="student"),
            result("DOC-3", True, 2.0, kind="access", answer=False, docs=("HR-REC-002",)),
        ],
        usage={"openai/gpt-6-luna": {"calls": 6, "input": 1000, "output": 100}},
        cost_usd=0.00015,
    )
    summary = summarize(run)
    assert summary["questions"] == 3 and summary["passed"] == 2
    assert summary["answerable"] == {"n": 2, "passed": 1}
    assert summary["must_refuse"] == {"n": 1, "passed": 1}
    assert summary["by_type"]["version"] == [0, 1] and summary["by_role"]["student"] == [0, 1]
    assert summary["latency_s"]["p50"] == 2.0 and summary["llm_calls"] == 6
    assert json.dumps(summary)


async def test_usage_is_counted_and_priced_per_model() -> None:
    class Inner:
        async def complete(self, *_a: object, **_k: object) -> ChatResult:
            return ChatResult("x", 1000, 200)

    chat = UsageChat(Inner())
    await chat.complete([], model="openai/gpt-6-luna")
    await chat.complete([], model="openai/gpt-6-luna")
    assert chat.calls == 2 and chat.tokens == (2000, 400)
    assert chat.cost() == pytest.approx((2000 * 0.10 + 400 * 0.50) / 1_000_000)
    await chat.complete([], model="some/unpriced-model")
    assert chat.cost() is None
