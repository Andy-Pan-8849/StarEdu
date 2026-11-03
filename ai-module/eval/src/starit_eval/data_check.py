"""Ask the assistant the structured-data questions (sample-data/eval/sql-qa.jsonl) for real.

Each question is asked by the named demo account. An answerable question passes when the answer
contains the reference value (every number and id in it); a question that must be refused passes
when the run ends as no_permission or not_found and the answer carries no data. The report also
shows how often a statement had to be retried and which questions the assistant got wrong.
"""

import json
import re
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncEngine
from starit_core.agent.runtime import AgentRuntime
from starit_core.auth import Identity
from starit_core.config import Settings
from starit_core.conversations import create_conversation
from starit_core.dataaccess.tools import DataTools
from starit_core.embeddings import EmbeddingClient
from starit_core.llm import ChatClient

from starit_eval.agent_check import CountingChat
from starit_eval.dataset import SAMPLE_DATA
from starit_eval.pricing import cost_usd

REFUSAL_STATES = ("no_permission", "not_found")
_TOKEN = re.compile(r"[A-Za-z]+\d+|\d+(?:\.\d+)?")


@dataclass(frozen=True)
class DataQuestion:
    id: str
    type: str
    question: str
    expected: str
    asker: str
    role: str
    should_answer: bool


@dataclass
class DataResult:
    question: DataQuestion
    end_state: str
    end_reason: str | None
    ok: bool
    problems: list[str]
    seconds: float
    answer: str
    llm_calls: int


@dataclass
class DataRun:
    results: list[DataResult] = field(default_factory=list)
    input_tokens: int = 0
    output_tokens: int = 0
    llm_calls: int = 0
    models: dict[str, str] = field(default_factory=dict)

    @property
    def passed(self) -> int:
        return sum(r.ok for r in self.results)


def load_data_questions(path: Path | None = None) -> list[DataQuestion]:
    path = path or SAMPLE_DATA / "eval" / "sql-qa.jsonl"
    questions = []
    for line in path.read_text(encoding="utf-8").splitlines():
        q = json.loads(line)
        questions.append(
            DataQuestion(
                q["id"],
                q["type"],
                q["question"],
                q["expected_answer"],
                q["asker"],
                q["role"],
                bool(q["should_answer"]),
            )  # fmt: skip
        )
    return questions


def load_askers(path: Path | None = None) -> dict[str, Identity]:
    import csv

    path = path or SAMPLE_DATA / "demo-accounts.csv"
    askers = {}
    with open(path, newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            student = row["subject_type"] == "student"
            askers[row["username"]] = Identity(
                user_id=row["username"],
                username=row["username"],
                name=row["name"],
                roles=frozenset({row["role"]}),
                campus_id=row["campus_id"],
                level=row["level"] or None,
                employee_id=None if student else row["subject_id"],
                student_id=row["subject_id"] if student else None,
            )
    return askers


def judge(question: DataQuestion, end_state: str, answer: str) -> list[str]:
    if not question.should_answer:
        problems = []
        if end_state not in REFUSAL_STATES:
            problems.append(f"ended as {end_state}, expected a refusal")
        if end_state == "answered":
            problems.append("answered a question it must not answer")
        return problems
    if end_state != "answered":
        return [f"ended as {end_state}, expected an answer"]
    flat = answer.replace(",", "")
    tokens = _TOKEN.findall(question.expected.replace(",", ""))
    if not tokens:
        return (
            []
            if question.expected.lower() in answer.lower()
            else [f"answer lacks {question.expected!r}"]
        )
    return [f"answer lacks {t!r}" for t in tokens if not _mentions(flat, t)]


def _mentions(answer: str, token: str) -> bool:
    """The token appears as a whole number or id; a decimal matches its longer spelling too
    (a reference 81.5 matches an answer of 81.5000000)."""
    if re.search(rf"(?<![\w.]){re.escape(token)}(?!\w|\.\d)", answer):
        return True
    if re.fullmatch(r"\d+\.\d+", token):
        return any(
            abs(float(n) - float(token)) < 1e-6
            for n in re.findall(r"(?<![\w.])\d+\.\d+(?!\w)", answer)
        )
    return False


def estimate(
    settings: Settings, questions: Sequence[DataQuestion]
) -> tuple[dict[str, int], float | None]:
    n = len(questions)
    calls = {"understand": n, "plan": n, "sql": n, "answer": n}
    parts = [
        cost_usd(settings.model_understand, n * 500, n * 80),
        cost_usd(settings.model_plan, n * 700, n * 60),
        cost_usd(settings.model_sql, n * 2400, n * 140),
        cost_usd(settings.model_generate, n * 900, n * 150),
    ]
    total = None if any(p is None for p in parts) else float(sum(p for p in parts if p is not None))
    return calls, total


async def run_data_check(
    engine: AsyncEngine,
    settings: Settings,
    embedder: EmbeddingClient,
    chat: ChatClient,
    askers: dict[str, Identity],
    questions: Sequence[DataQuestion],
) -> DataRun:
    counting = CountingChat(chat)
    runtime = AgentRuntime(
        engine=engine,
        settings=settings,
        embedder=embedder,
        chat=counting,
        data_tools=DataTools(engine, settings, embedder),
    )
    run = DataRun(
        models={
            "understand": settings.model_understand,
            "plan": settings.model_plan,
            "sql": settings.model_sql,
            "answer": settings.model_generate,
        }
    )
    for q in questions:
        identity = askers[q.asker]
        async with engine.begin() as conn:
            conversation_id = (await create_conversation(conn, identity))["id"]
        before = counting.calls
        started = time.perf_counter()
        result = await runtime.run(identity, conversation_id, q.question)
        problems = judge(q, result.end_state, result.content)
        run.results.append(
            DataResult(
                q,
                result.end_state,
                result.end_reason,
                not problems,
                problems,
                time.perf_counter() - started,
                result.content,
                counting.calls - before,
            )  # fmt: skip
        )
    run.llm_calls = counting.calls
    run.input_tokens = counting.input_tokens
    run.output_tokens = counting.output_tokens
    return run


def render(run: DataRun, estimate_usd: float | None) -> str:
    answerable = [r for r in run.results if r.question.should_answer]
    refused = [r for r in run.results if not r.question.should_answer]
    by_type: dict[str, list[DataResult]] = {}
    for r in run.results:
        by_type.setdefault(r.question.type, []).append(r)
    lines = [
        "# Data questions: the assistant against sql-qa.jsonl",
        "",
        f"Run at {datetime.now(UTC).strftime('%Y-%m-%d %H:%M UTC')}. Models: "
        + ", ".join(f"{k} `{v}`" for k, v in run.models.items())
        + ".",
        "",
        f"- Passed {run.passed} of {len(run.results)}: "
        f"{sum(r.ok for r in answerable)}/{len(answerable)} answerable, "
        f"{sum(r.ok for r in refused)}/{len(refused)} to be refused.",
        f"- Model calls {run.llm_calls}, tokens {run.input_tokens} in / {run.output_tokens} out"
        + ("" if estimate_usd is None else f"; estimated before the run: about ${estimate_usd:.3f}")
        + ".",
        "- More than 4 model calls for one question means a statement was retried.",
        "",
        "| Type | Passed |",
        "|---|---|",
        *[f"| {t} | {sum(r.ok for r in rs)}/{len(rs)} |" for t, rs in sorted(by_type.items())],
        "",
        "| # | Asker | Question | Expected | Ended | Calls | Time | Result |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for r in run.results:
        q = r.question
        expected = q.expected if q.should_answer else "refuse"
        mark = "✅" if r.ok else "❌ " + "; ".join(r.problems)
        lines.append(
            f"| {q.id} | {q.role} | {q.question} | {expected} | {r.end_state}/{r.end_reason} "
            f"| {r.llm_calls} | {r.seconds:.1f}s | {mark} |"
        )
    wrong = [r for r in run.results if not r.ok]
    if wrong:
        lines += ["", "## Answers that failed", ""]
        for r in wrong:
            lines += [f"**{r.question.id}** {r.question.question}", "", f"> {r.answer}", ""]
    return "\n".join(lines) + "\n"


def write(out_dir: Path, run: DataRun, estimate_usd: float | None) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"data-check-{datetime.now(UTC).strftime('%Y%m%d-%H%M')}.md"
    path.write_text(render(run, estimate_usd), encoding="utf-8")
    return path


def summarize_for_console(run: DataRun) -> str:
    wrong = [r.question.id for r in run.results if not r.ok]
    return (
        f"{run.passed}/{len(run.results)} passed, {run.llm_calls} model calls, "
        f"{run.input_tokens} in / {run.output_tokens} out tokens"
        + (f"; failed: {', '.join(wrong)}" if wrong else "")
    )
