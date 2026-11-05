"""文件：answers.py
作用：真正调用助手回答 114 道文档题，并给回答打分。
判分顺序（每道题）：
  1. 该拒绝的题：运行以拒绝类结局结束、并且没有引用被保护的那份文档，才算通过；
  2. 该回答的题：必须以 answered 结束。然后：
     - 题目带 facts（必须出现的数字、编号、词）的，做确定性检查：全部出现才通过；
     - 不带 facts 的，让另一个模型（判官）对照参考答案判断；
  3. 任何题的（结局, 原因）组合都必须合法。
人工复核：随机抽 1/5（固定随机种子，可复现）导出成 CSV 给人检查；
在抽查完成之前，自动判分的结论不能当作事实（判官可能偏严或偏松）。
"""

import json
import random
import re
import statistics
import time
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine
from starit_core.agent.runtime import AgentRuntime
from starit_core.auth import Identity
from starit_core.config import Settings
from starit_core.conversations import create_conversation
from starit_core.dataaccess.tools import DataTools
from starit_core.embeddings import EmbeddingClient
from starit_core.llm import ChatClient, ChatError, ChatResult, parse_json_object

from starit_eval.dataset import Question
from starit_eval.pricing import cost_usd

# 算“拒绝”的结局：无权限 / 没找到 / 拒绝
REFUSAL_STATES = ("no_permission", "not_found", "refused")
# 每种结局允许出现的原因；不在表里的组合说明流程有 bug
LEGAL_REASONS: dict[str, tuple[str | None, ...]] = {
    "answered": (None,),
    "need_clarification": ("ambiguous_question",),
    "no_permission": ("restricted_document", "restricted_data"),
    "not_found": ("no_relevant_documents", "no_matching_rows", "clarification_limit"),
    "refused": ("out_of_scope", "input_blocked", "write_not_enabled"),
}
# 人工抽查比例（1/5）与固定随机种子，保证每次抽到同样的题
SAMPLE_FRACTION = 0.2
SAMPLE_SEED = 20261104

# 判官的指令：只对照参考答案判断关键事实对不对，返回 JSON {verdict, reason}
JUDGE_SYSTEM = (
    "You grade answers of a company assistant. You get a question, a reference answer written by "
    "the dataset's author, and the assistant's answer. Reply with one JSON object and nothing "
    'else: {"verdict": "correct" or "incorrect", "reason": "one short sentence"}. '
    "correct: the assistant's answer gives the same key facts as the reference (figures, names, "
    "conditions); wording may differ; extra correct detail is fine. incorrect: a key fact is "
    "missing or different, or the answer contradicts the reference, or it only says it cannot "
    "answer. Judge only against the reference."
)


class UsageChat:
    """包住聊天客户端，按模型统计调用次数和 token，以便逐个模型计价。"""

    def __init__(self, inner: ChatClient) -> None:
        self._inner = inner
        self.by_model: dict[str, dict[str, int]] = defaultdict(
            lambda: {"calls": 0, "input": 0, "output": 0}
        )

    async def complete(self, *args: Any, **kwargs: Any) -> ChatResult:
        result: ChatResult = await self._inner.complete(*args, **kwargs)
        model = str(kwargs.get("model", "?"))
        usage = self.by_model[model]
        usage["calls"] += 1
        usage["input"] += result.input_tokens
        usage["output"] += result.output_tokens
        return result

    @property
    def calls(self) -> int:
        return sum(u["calls"] for u in self.by_model.values())

    @property
    def tokens(self) -> tuple[int, int]:
        return (
            sum(u["input"] for u in self.by_model.values()),
            sum(u["output"] for u in self.by_model.values()),
        )

    def cost(self) -> float | None:
        """按价目表合计费用；只要有模型没标价就返回 None（宁可说不知道）。"""
        parts = [cost_usd(m, u["input"], u["output"]) for m, u in self.by_model.items()]
        return (
            None if any(p is None for p in parts) else float(sum(p for p in parts if p is not None))
        )


def estimate(
    settings: Settings, questions: Sequence[Question], avg_chunk_tokens: int
) -> tuple[dict[str, int], float | None]:
    """运行前估算：模型调用次数的上限（不含重试）和按标价的费用。

    参数：settings 配置；questions 题目；avg_chunk_tokens 平均块大小。
    返回：({步骤: 调用次数}, 费用或 None)。管理角色没有可读文档，不会走检索和生成，所以不计入。
    """
    readers = [q for q in questions if q.role not in ("Admin", "RAGETLADMIN", "RAGETLAdmin")]
    judged = sum(1 for q in readers if q.should_answer and not q.facts)
    calls = {
        "understand": len(questions),
        "rerank": len(readers),
        "generate": len(readers),
        "judge": judged,
    }
    rerank_in = 160 + settings.retrieval_rerank_in * (
        min(avg_chunk_tokens, settings.rerank_passage_tokens) + 40
    )
    generate_in = 700 + settings.retrieval_final_k * avg_chunk_tokens
    parts = [
        cost_usd(settings.model_understand, calls["understand"] * 500, calls["understand"] * 80),
        cost_usd(settings.model_rerank, calls["rerank"] * rerank_in, calls["rerank"] * 240),
        cost_usd(settings.model_generate, calls["generate"] * generate_in, calls["generate"] * 200),
        cost_usd(settings.model_judge, calls["judge"] * 450, calls["judge"] * 60),
    ]
    total = None if any(p is None for p in parts) else float(sum(p for p in parts if p is not None))
    return calls, total


def normalize(value: str) -> str:
    """统一写法再比较：转小写，数字里的千分位逗号去掉（3,000 与 3000 视为同一个数）。"""
    return re.sub(r"(?<=\d),(?=\d)", "", value).lower()


def missing_facts(facts: Sequence[str], answer: str) -> list[str]:
    """返回回答里缺少的事实。每个事实要作为独立的词出现（前后不能是字母数字，
    也不能是小数的一部分）；开头允许多一个 v，这样事实 2.1 能匹配常见写法 v2.1。
    """
    haystack = normalize(answer)
    absent = []
    for fact in facts:
        needle = normalize(fact)
        # An optional leading v lets the fact 2.1 match "v2.1", as versions are usually written.
        pattern = rf"(?<![\w.])v?{re.escape(needle)}(?!\w|\.\d)"
        if not re.search(pattern, haystack):
            absent.append(fact)
    return absent


def end_state_is_legal(end_state: str, end_reason: str | None) -> bool:
    """（结局, 原因）组合是否合法；error 结局只要求有原因。"""
    if end_state == "error":
        return bool(end_reason)
    return end_reason in LEGAL_REASONS.get(end_state, ())


async def judge_answer(
    chat: ChatClient, model: str, question: str, reference: str, answer: str
) -> tuple[bool | None, str]:
    """让判官对照参考答案判断回答对不对。返回 (True/False/None, 理由)，None
    表示判官没给出可用结论。
    """
    user = f"Question: {question}\n\nReference answer: {reference}\n\nAssistant's answer: {answer}"
    try:
        reply = await chat.complete(
            [{"role": "system", "content": JUDGE_SYSTEM}, {"role": "user", "content": user}],
            model=model,
            json_mode=True,
            max_tokens=200,
        )
        data = parse_json_object(reply.text)
    except ChatError as exc:
        return None, f"judge failed: {exc}"
    verdict = str(data.get("verdict", "")).strip().lower()
    reason = str(data.get("reason", "")).strip()
    if verdict == "correct":
        return True, reason
    if verdict == "incorrect":
        return False, reason
    return None, f"unreadable verdict: {verdict!r}"


@dataclass
class AnswerResult:
    """一道题的结果：结局、回答、引用的文档、是否通过、判分方法(refusal/facts/judge)、问题列表等。"""

    question: Question
    end_state: str
    end_reason: str | None
    content: str
    cited_docs: list[str]
    passed: bool
    method: str  # "refusal", "facts" or "judge"
    problems: list[str]
    legal_end: bool
    cites_source: bool | None  # None when the question has no source document
    judge_reason: str = ""
    seconds: float = 0.0
    llm_calls: int = 0


@dataclass
class AnswersRun:
    """一次答案评测的全部结果，以及所用模型、token 用量和费用。"""

    results: list[AnswerResult] = field(default_factory=list)
    models: dict[str, str] = field(default_factory=dict)
    usage: dict[str, dict[str, int]] = field(default_factory=dict)
    cost_usd: float | None = None


async def grade(
    question: Question,
    end_state: str,
    end_reason: str | None,
    content: str,
    cited_docs: list[str],
    judge: Any,
) -> tuple[bool, str, list[str], str]:
    """给一道题的回答判分，返回 (是否通过, 判分方法, 问题列表, 判官理由)。

    参数：question 题；end_state/end_reason 结局；content 回答；cited_docs 回答引用的文档；
      judge 异步函数 (题, 回答) -> 判官结论。
    规则见文件头。
    """
    problems: list[str] = []
    if not question.should_answer:
        if end_state not in REFUSAL_STATES:
            problems.append(f"ended as {end_state}, expected a refusal")
        leaked = sorted(set(question.source_docs) & set(cited_docs))
        if leaked:
            problems.append(f"cites the restricted document {', '.join(leaked)}")
        return not problems, "refusal", problems, ""
    if end_state != "answered":
        return False, "facts" if question.facts else "judge", [f"ended as {end_state}"], ""
    if question.facts:
        absent = missing_facts(question.facts, content)
        problems += [f"answer lacks {fact!r}" for fact in absent]
        return not problems, "facts", problems, ""
    verdict, reason = await judge(question, content)
    if verdict is None:
        return False, "judge", ["the judge gave no verdict"], reason
    if not verdict:
        problems.append("the judge found a key fact missing or wrong")
    return not problems, "judge", problems, reason


async def run_answers(
    engine: AsyncEngine,
    settings: Settings,
    embedder: EmbeddingClient,
    chat: UsageChat,
    identities: Mapping[str, Identity],
    questions: Sequence[Question],
    *,
    with_data_tools: bool = False,
    progress: Any = None,
    retrieve_fn: Any = None,
) -> AnswersRun:
    """依次让助手回答每道题（每题新开一个会话），并判分。

    参数：engine 引擎；settings 配置；embedder 嵌入客户端；chat 带用量统计的聊天客户端；
      identities 角色->身份；questions 题目；with_data_tools 是否接入数据工具；
      progress 进度回调(第几题, 共几题)；retrieve_fn 可替换的检索函数。
    返回：AnswersRun。
    """
    runtime = AgentRuntime(
        engine=engine,
        settings=settings,
        embedder=embedder,
        chat=chat,
        data_tools=DataTools(engine, settings, embedder) if with_data_tools else None,
        **({"retrieve_fn": retrieve_fn} if retrieve_fn is not None else {}),
    )
    run = AnswersRun(
        models={
            "understand": settings.model_understand,
            "rerank": settings.model_rerank,
            "generate": settings.model_generate,
            "judge": settings.model_judge,
        }
    )

    async def judge(question: Question, answer: str) -> tuple[bool | None, str]:
        return await judge_answer(
            chat, settings.model_judge, question.question, question.expected_answer, answer
        )

    for index, question in enumerate(questions, start=1):
        identity = identities[question.role]
        async with engine.begin() as conn:
            conversation_id = (await create_conversation(conn, identity))["id"]
        before = chat.calls
        started = time.perf_counter()
        result = await runtime.run(identity, conversation_id, question.question)
        cited = sorted({str(c["doc_code"]) for c in result.citations if "doc_code" in c})
        ok, method, problems, reason = await grade(
            question,
            result.end_state,
            result.end_reason,
            result.content,
            cited,
            lambda q, a: judge(q, a),
        )
        legal = end_state_is_legal(result.end_state, result.end_reason)
        if not legal:
            problems.append(f"illegal end {result.end_state}/{result.end_reason}")
        run.results.append(
            AnswerResult(
                question=question,
                end_state=result.end_state,
                end_reason=result.end_reason,
                content=result.content,
                cited_docs=cited,
                passed=ok and legal,
                method=method,
                problems=problems,
                legal_end=legal,
                cites_source=(
                    bool(set(question.source_docs) & set(cited))
                    if question.source_docs and question.should_answer
                    else None
                ),
                judge_reason=reason,
                seconds=time.perf_counter() - started,
                llm_calls=chat.calls - before,
            )
        )
        if progress:
            progress(index, len(questions))
    run.usage = {m: dict(u) for m, u in chat.by_model.items()}
    run.cost_usd = chat.cost()
    return run


def percentile(values: Sequence[float], q: float) -> float:
    """线性插值的百分位数（q 取 0~1）；没有数据返回 0。"""
    ordered = sorted(values)
    if not ordered:
        return 0.0
    position = (len(ordered) - 1) * q
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def summarize(run: AnswersRun) -> dict[str, Any]:
    """汇总：通过数（总体/应回答/应拒绝）、按题型和角色、判分方式分布、引用来源比例、延迟、token、
    费用。
    """
    results = run.results
    answerable = [r for r in results if r.question.should_answer]
    refused = [r for r in results if not r.question.should_answer]
    by_type: dict[str, list[AnswerResult]] = defaultdict(list)
    by_role: dict[str, list[AnswerResult]] = defaultdict(list)
    for r in results:
        by_type[r.question.type].append(r)
        by_role[r.question.role].append(r)
    cites = [
        r.cites_source
        for r in answerable
        if r.cites_source is not None and r.end_state == "answered"
    ]
    seconds = [r.seconds for r in results]
    return {
        "questions": len(results),
        "passed": sum(r.passed for r in results),
        "answerable": {"n": len(answerable), "passed": sum(r.passed for r in answerable)},
        "must_refuse": {"n": len(refused), "passed": sum(r.passed for r in refused)},
        "clarified_instead_of_answering": sum(
            1 for r in answerable if r.end_state == "need_clarification"
        ),
        "by_type": {t: [sum(r.passed for r in rs), len(rs)] for t, rs in sorted(by_type.items())},
        "by_role": {t: [sum(r.passed for r in rs), len(rs)] for t, rs in sorted(by_role.items())},
        "graded_by": {
            m: sum(1 for r in results if r.method == m) for m in ("facts", "judge", "refusal")
        },
        "legal_end_states": sum(r.legal_end for r in results),
        "cites_a_source": [sum(cites), len(cites)],
        "latency_s": {
            "p50": round(statistics.median(seconds), 2) if seconds else 0.0,
            "p95": round(percentile(seconds, 0.95), 2),
        },
        "llm_calls": sum(u["calls"] for u in run.usage.values()),
        "tokens": {
            "input": sum(u["input"] for u in run.usage.values()),
            "output": sum(u["output"] for u in run.usage.values()),
        },
        "cost_usd": None if run.cost_usd is None else round(run.cost_usd, 4),
    }


def review_sample(results: Sequence[AnswerResult]) -> list[AnswerResult]:
    """取可复现的 1/5 结果，按题号排序，交给人工检查。"""
    count = max(1, round(len(results) * SAMPLE_FRACTION))
    return sorted(
        random.Random(SAMPLE_SEED).sample(list(results), count), key=lambda r: r.question.id
    )


def review_csv(results: Sequence[AnswerResult]) -> str:
    """生成人工抽查表 CSV：题、参考答案、助手回答、自动结论，以及留空的人工结论列。"""
    import csv
    import io

    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(
        [
            "id",
            "role",
            "type",
            "question",
            "reference",
            "answer",
            "end_state",
            "auto_verdict",
            "method",
            "human_verdict",
            "human_note",
        ]
    )
    for r in review_sample(results):
        writer.writerow(
            [
                r.question.id,
                r.question.role,
                r.question.type,
                r.question.question,
                r.question.expected_answer,
                r.content,
                f"{r.end_state}/{r.end_reason}",
                "pass" if r.passed else "fail",
                r.method,
                "",
                "",
            ]
        )
    return out.getvalue()


def render(run: AnswersRun, summary: dict[str, Any], estimate_usd: float | None) -> str:
    """生成中文 Markdown 报告：总体数字、按题型/角色、没通过的题（带参考答案和助手回答）。"""
    date = datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
    a, m = summary["answerable"], summary["must_refuse"]
    lines = [
        f"# 答案评测（{date}）",
        "",
        "模型：" + "，".join(f"{k} `{v}`" for k, v in run.models.items()) + "。",
        "",
        f"- 通过 {summary['passed']}/{summary['questions']}：应回答 {a['passed']}/{a['n']}，应拒绝 {m['passed']}/{m['n']}。",  # noqa: E501
        f"- 判分方式：确定性事实 {summary['graded_by']['facts']} 题，模型判官 {summary['graded_by']['judge']} 题，拒绝判定 {summary['graded_by']['refusal']} 题。**判官的结论在人工抽查之前不能当作事实**（抽查表见同名 `.csv`）。",  # noqa: E501
        f"- 应回答的题里，反问澄清而没有回答：{summary['clarified_instead_of_answering']} 题。",
        f"- 结束状态合法：{summary['legal_end_states']}/{summary['questions']}。引用了来源文档：{summary['cites_a_source'][0]}/{summary['cites_a_source'][1]}（只统计答出来的题）。",  # noqa: E501
        f"- 延迟 p50 {summary['latency_s']['p50']} 秒，p95 {summary['latency_s']['p95']} 秒；模型调用 {summary['llm_calls']} 次，token {summary['tokens']['input']} 入 / {summary['tokens']['output']} 出；"  # noqa: E501
        + (
            "费用无法估算（有模型没有标价）"
            if summary["cost_usd"] is None
            else f"按标价约 {summary['cost_usd']} 美元"
        )
        + ("" if estimate_usd is None else f"（运行前估算 {estimate_usd:.3f} 美元）")
        + "。",
        "",
        "| 题型 | 通过 |",
        "|---|---|",
        *[f"| {t} | {p}/{n} |" for t, (p, n) in summary["by_type"].items()],
        "",
        "| 提问角色 | 通过 |",
        "|---|---|",
        *[f"| {t} | {p}/{n} |" for t, (p, n) in summary["by_role"].items()],
        "",
    ]
    wrong = [r for r in run.results if not r.passed]
    lines += [f"## 没有通过的题（{len(wrong)}）", ""]
    for r in wrong:
        lines += [
            f"**{r.question.id}**（{r.question.type}，{r.question.role}，{r.method}）{r.question.question}",
            "",
            f"- 结束：{r.end_state}/{r.end_reason}；问题：{'；'.join(r.problems)}",
            f"- 参考答案：{r.question.expected_answer}",
            f"- 助手的回答：{r.content}",
            *([f"- 判官：{r.judge_reason}"] if r.judge_reason else []),
            "",
        ]
    return "\n".join(lines) + "\n"


def write(
    out_dir: Path, run: AnswersRun, summary: dict[str, Any], estimate_usd: float | None
) -> Path:
    """写出 .md 报告、.csv 抽查表和 .json 明细，返回 .md 的路径。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M")
    base = out_dir / f"answers-{stamp}"
    base.with_suffix(".md").write_text(render(run, summary, estimate_usd), encoding="utf-8")
    base.with_suffix(".csv").write_text(review_csv(run.results), encoding="utf-8")
    payload = {
        "summary": summary,
        "results": [
            {
                "id": r.question.id,
                "role": r.question.role,
                "type": r.question.type,
                "passed": r.passed,
                "method": r.method,
                "end": f"{r.end_state}/{r.end_reason}",
                "problems": r.problems,
                "cited": r.cited_docs,
                "seconds": round(r.seconds, 2),
                "answer": r.content,
            }
            for r in run.results
        ],
    }
    base.with_suffix(".json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return base.with_suffix(".md")


async def store(
    engine: AsyncEngine, run: AnswersRun, summary: dict[str, Any], sha: str | None, label: str
) -> str:
    """把这次运行写入 ai.eval_runs，每题一行写入 ai.eval_results。返回运行 ID。"""
    async with engine.begin() as conn:
        run_id = (
            await conn.execute(
                text(
                    "INSERT INTO ai.eval_runs (git_sha, config, summary) "
                    "VALUES (:sha, CAST(:config AS jsonb), CAST(:summary AS jsonb)) RETURNING id"
                ),
                {
                    "sha": sha,
                    "config": json.dumps({"kind": "answers", "label": label, "models": run.models}),
                    "summary": json.dumps(summary),
                },
            )
        ).scalar_one()
        for r in run.results:
            await conn.execute(
                text(
                    "INSERT INTO ai.eval_results (run_id, question_id, role, answer, passed, retrieved_doc_ids, latency_ms, notes) "  # noqa: E501
                    "VALUES (:run, :q, :role, :answer, :passed, CAST(:docs AS text[]), :ms, :notes)"
                ),
                {
                    "run": run_id,
                    "q": r.question.id,
                    "role": r.question.role,
                    "answer": r.content,
                    "passed": r.passed,
                    "docs": r.cited_docs,
                    "ms": int(r.seconds * 1000),
                    "notes": json.dumps(
                        {
                            "method": r.method,
                            "end": f"{r.end_state}/{r.end_reason}",
                            "problems": r.problems,
                            "judge": r.judge_reason,
                        }
                    ),
                },
            )
    return str(run_id)
