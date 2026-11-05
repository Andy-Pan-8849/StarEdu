"""文件：data_check.py
作用：真实调用助手回答“业务数据题”(sample-data/eval/sql-qa.jsonl，共 41 道)，并判分。
每道题由题里指定的演示账号来问，因为答案取决于“谁在问”（学员只看自己，主管看本校区……）。
判分：
  - 该回答的题：回答里必须出现参考答案中的每个数字和编号；
  - 该拒绝的题：运行必须以 no_permission 或 not_found 结束，且回答里不带数据。
报告还会统计：SQL 被打回重写的频率，以及哪些题答错了。
"""

import json
import re
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

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

# 算“拒绝”的结局（数据题没有 refused）
REFUSAL_STATES = ("no_permission", "not_found")
# 从参考答案里抽出需要核对的数字和编号（如 C0035、81.5、14604）
_TOKEN = re.compile(r"[A-Za-z]+\d+|\d+(?:\.\d+)?")


@dataclass(frozen=True)
class DataQuestion:
    """一道数据题：题目、参考答案、提问账号和角色、该回答还是该拒绝。"""

    id: str
    type: str
    question: str
    expected: str
    asker: str
    role: str
    should_answer: bool


@dataclass
class DataResult:
    """一道数据题的结果：结局、是否通过、问题、耗时、回答、模型调用次数。"""

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
    """一次数据评测的全部结果和用量；passed 是通过的题数。"""

    results: list[DataResult] = field(default_factory=list)
    input_tokens: int = 0
    output_tokens: int = 0
    llm_calls: int = 0
    models: dict[str, str] = field(default_factory=dict)

    @property
    def passed(self) -> int:
        return sum(r.ok for r in self.results)


def load_data_questions(path: Path | None = None) -> list[DataQuestion]:
    """读取数据题（默认 sample-data/eval/sql-qa.jsonl）。"""
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
    """读取演示账号，返回 账号名 -> Identity（每个账号都是示例数据里的真实一员）。"""
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
    """给一道数据题的回答找问题，返回问题列表（空表示通过）。

    该拒绝：结局必须是拒绝类，且不能 answered。
    该回答：结局必须是 answered，并且参考答案里的每个数字/编号都出现在回答里
    （去掉千分位逗号；没有数字的参考答案做不分大小写的包含检查）。
    """
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
    """运行前估算：四个步骤(理解/规划/写SQL/作答)的调用次数上限和按标价的费用。"""
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
    """依次用提问账号问每道数据题（接入数据工具），记录结局、回答、耗时和调用次数。返回 DataRun。"""
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
    """生成中文 Markdown 报告：总体通过数、没通过的题（参考答案和实际回答）、用量。"""
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
    """写报告文件，返回路径。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"data-check-{datetime.now(UTC).strftime('%Y%m%d-%H%M')}.md"
    path.write_text(render(run, estimate_usd), encoding="utf-8")
    return path


def summarize_for_console(run: DataRun) -> str:
    """控制台上的一两行摘要。"""
    wrong = [r.question.id for r in run.results if not r.ok]
    return (
        f"{run.passed}/{len(run.results)} passed, {run.llm_calls} model calls, "
        f"{run.input_tokens} in / {run.output_tokens} out tokens"
        + (f"; failed: {', '.join(wrong)}" if wrong else "")
    )


def summarize(run: DataRun) -> dict[str, Any]:
    """汇总成字典：总数、通过数、应回答/应拒绝各自的通过数、没通过的题号、用量。"""
    answerable = [r for r in run.results if r.question.should_answer]
    refused = [r for r in run.results if not r.question.should_answer]
    by_type: dict[str, list[DataResult]] = {}
    for r in run.results:
        by_type.setdefault(r.question.type, []).append(r)
    return {
        "questions": len(run.results),
        "passed": run.passed,
        "answerable": {"n": len(answerable), "passed": sum(r.ok for r in answerable)},
        "must_refuse": {"n": len(refused), "passed": sum(r.ok for r in refused)},
        "by_type": {t: [sum(r.ok for r in rs), len(rs)] for t, rs in sorted(by_type.items())},
        "llm_calls": run.llm_calls,
        "tokens": {"input": run.input_tokens, "output": run.output_tokens},
        "failed": [r.question.id for r in run.results if not r.ok],
    }


async def store(engine: AsyncEngine, run: DataRun, sha: str | None, label: str) -> str:
    """Record the run in ai.eval_runs and one row per question in ai.eval_results."""
    from sqlalchemy import text

    async with engine.begin() as conn:
        run_id = (
            await conn.execute(
                text(
                    "INSERT INTO ai.eval_runs (git_sha, config, summary) "
                    "VALUES (:sha, CAST(:config AS jsonb), CAST(:summary AS jsonb)) RETURNING id"
                ),
                {
                    "sha": sha,
                    "config": json.dumps({"kind": "data", "label": label, "models": run.models}),
                    "summary": json.dumps(summarize(run)),
                },
            )
        ).scalar_one()
        for r in run.results:
            await conn.execute(
                text(
                    "INSERT INTO ai.eval_results (run_id, question_id, role, answer, passed, "
                    "latency_ms, notes) VALUES (:run, :q, :role, :answer, :passed, :ms, :notes)"
                ),
                {
                    "run": run_id,
                    "q": r.question.id,
                    "role": r.question.role,
                    "answer": r.answer,
                    "passed": r.ok,
                    "ms": int(r.seconds * 1000),
                    "notes": json.dumps(
                        {"end": f"{r.end_state}/{r.end_reason}", "problems": r.problems}
                    ),
                },
            )
    return str(run_id)
