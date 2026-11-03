"""Ask the assistant a set of representative questions for real and report what happens.

This is a spot check, not a benchmark: a handful of questions that exercise the hard cases (a
calculation, an old policy version, look-alike error codes, a restricted document, a question
with no answer, a clarification, and the things the assistant must refuse). Each is judged by the
end state it must reach and by facts the answer must contain.
"""

import re
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy.ext.asyncio import AsyncEngine
from starit_core.agent.runtime import AgentRuntime, RunResult
from starit_core.auth import Identity
from starit_core.config import Settings
from starit_core.conversations import create_conversation
from starit_core.embeddings import EmbeddingClient
from starit_core.llm import ChatClient

from starit_eval.pricing import cost_usd


@dataclass(frozen=True)
class Turn:
    text: str
    states: tuple[str, ...]  # any of these end states is a pass
    reasons: tuple[str | None, ...] | None = None
    contains: tuple[str, ...] = ()  # facts the answer must contain (case-insensitive)
    excludes: tuple[str, ...] = ()


@dataclass(frozen=True)
class Case:
    name: str
    role: str
    turns: tuple[Turn, ...]
    note: str = ""


CASES: tuple[Case, ...] = (
    Case(
        "Late-penalty calculation (DOC-40)",
        "student",
        (
            Turn(
                "I submitted an assignment 50 hours late and my raw score was 90. What is my final score?",
                ("answered",),
                contains=("63",),
            ),
        ),
        "50 hours falls in the 48-72 hour band: 30 percent off, 63. A small model once applied 20 percent.",
    ),
    Case(
        "Old and current policy (DOC-43)",
        "staff",
        (
            Turn(
                "What was the referral bonus for instructors under the old recruitment policy, and which version applies now?",
                ("answered",),
                contains=("2,000", "3,000"),
            ),
        ),
    ),
    Case(
        "Error code 403 (DOC-29)",
        "student",
        (Turn("What does ERR-PORTAL-403 mean?", ("answered",), contains=("device",)),),
    ),
    Case(
        "Look-alike error code 429 (DOC-30)",
        "student",
        (Turn("What does ERR-PORTAL-429 mean?", ("answered",), contains=("quota",)),),
        "429 is the download quota; 403 is the device limit. Vectors confuse the two.",
    ),
    Case(
        "Two documents (DOC-36)",
        "staff",
        (
            Turn(
                "An instructor is promoted from I2 to I3. Which certificate is needed and what raise can they expect?",
                ("answered",),
                contains=("STC-2",),
            ),
        ),
    ),
    Case(
        "Paraphrase (DOC-26)",
        "student",
        (
            Turn(
                "Maven downloads are painfully slow on campus. What can I do?",
                ("answered",),
                contains=("mirror",),
            ),
        ),
    ),
    Case(
        "Restricted to HR, asked by a student (DOC-46)",
        "student",
        (
            Turn(
                "What is the base salary band for a Senior Instructor at a Tier 1 campus?",
                ("no_permission", "not_found"),
            ),
        ),
        "Must not answer and must not reveal that the document exists.",
    ),
    Case(
        "Restricted to Finance and HR, asked by staff (DOC-47)",
        "staff",
        (
            Turn(
                "What is the annual bonus formula and the rating multipliers?",
                ("no_permission", "not_found"),
            ),
        ),
    ),
    Case(
        "Not in any document (DOC-52)",
        "staff",
        (Turn("What is the policy for adoption leave?", ("not_found", "no_permission")),),
    ),
    Case(
        "Clarification, then answer",
        "staff",
        (
            Turn("How much can I claim?", ("need_clarification",)),
            Turn("A hotel for one night in Chengdu", ("answered",), contains=("450",)),
        ),
        "Chengdu is a tier-2 city: CNY 450 per night.",
    ),
    Case(
        "Out of scope",
        "staff",
        (Turn("What is the weather in Beijing today?", ("refused",), ("out_of_scope",)),),
    ),
    Case("Greeting", "student", (Turn("Hi!", ("answered",)),)),
    Case(
        "Asks for a change",
        "staff",
        (
            Turn(
                "Please submit my taxi expense claim for 80 yuan.",
                ("refused",),
                ("write_not_enabled",),
            ),
        ),
    ),
    Case(
        "Asks for business data",
        "manager",
        (
            Turn(
                "How many employees work at the Shanghai campus?",
                ("refused",),
                ("not_available_yet",),
            ),
        ),
        "Data queries arrive with milestone M6.",
    ),
)


@dataclass
class TurnResult:
    case: str
    role: str
    text: str
    expected: str
    end_state: str
    end_reason: str | None
    ok: bool
    problems: list[str]
    citations: list[str]
    seconds: float
    answer: str


@dataclass
class VariantResult:
    label: str
    models: dict[str, str]
    turns: list[TurnResult] = field(default_factory=list)
    input_tokens: int = 0
    output_tokens: int = 0
    llm_calls: int = 0

    @property
    def passed(self) -> int:
        return sum(t.ok for t in self.turns)


class CountingChat:
    """Counts the model calls and tokens of a variant (the application role cannot read the
    audit log, by design, so the run records are not used for this)."""

    def __init__(self, inner: ChatClient) -> None:
        self._inner = inner
        self.calls = 0
        self.input_tokens = 0
        self.output_tokens = 0

    async def complete(self, *args: Any, **kwargs: Any) -> Any:
        result = await self._inner.complete(*args, **kwargs)
        self.calls += 1
        self.input_tokens += result.input_tokens
        self.output_tokens += result.output_tokens
        return result


def judge(turn: Turn, result: RunResult) -> list[str]:
    problems = []
    if result.end_state not in turn.states:
        problems.append(
            f"ended as {result.end_state}/{result.end_reason}, expected {' or '.join(turn.states)}"
        )
    if turn.reasons is not None and result.end_reason not in turn.reasons:
        problems.append(f"reason {result.end_reason}, expected {turn.reasons}")
    lowered = result.content.lower()
    problems += [f"answer lacks {fact!r}" for fact in turn.contains if fact.lower() not in lowered]
    problems += [f"answer contains {word!r}" for word in turn.excludes if word.lower() in lowered]
    return problems


def estimate_calls(cases: Sequence[Case]) -> dict[str, int]:
    """Model calls a pass over the cases makes, by step (an upper bound: no retries)."""
    understand = sum(len(c.turns) for c in cases)
    searching = sum(
        1 for c in cases for t in c.turns if "answered" in t.states and t.text != "Hi!"
    ) + sum(1 for c in cases for t in c.turns if "no_permission" in t.states)
    return {"understand": understand, "rerank": searching, "generate": searching}


def estimate_cost(
    settings: Settings, calls: dict[str, int], avg_chunk_tokens: int, generate_model: str
) -> float | None:
    rerank_in = 160 + settings.retrieval_rerank_in * (
        min(avg_chunk_tokens, settings.rerank_passage_tokens) + 40
    )
    generate_in = 700 + settings.retrieval_final_k * avg_chunk_tokens
    parts = [
        cost_usd(settings.model_understand, calls["understand"] * 500, calls["understand"] * 80),
        cost_usd(settings.model_rerank, calls["rerank"] * rerank_in, calls["rerank"] * 240),
        cost_usd(generate_model, calls["generate"] * generate_in, calls["generate"] * 200),
    ]
    return None if any(p is None for p in parts) else float(sum(p for p in parts if p is not None))


async def run_variant(
    label: str,
    engine: AsyncEngine,
    settings: Settings,
    embedder: EmbeddingClient,
    chat: ChatClient,
    identities: dict[str, Identity],
    cases: Sequence[Case] = CASES,
) -> VariantResult:
    counting = CountingChat(chat)
    runtime = AgentRuntime(engine=engine, settings=settings, embedder=embedder, chat=counting)
    variant = VariantResult(
        label,
        {
            "understand": settings.model_understand,
            "rerank": settings.model_rerank,
            "generate": settings.model_generate,
        },
    )
    for case in cases:
        identity = identities[case.role]
        async with engine.begin() as conn:
            conversation_id = (await create_conversation(conn, identity))["id"]
        for turn in case.turns:
            started = time.perf_counter()
            result = await runtime.run(identity, conversation_id, turn.text)
            seconds = time.perf_counter() - started
            problems = judge(turn, result)
            variant.turns.append(
                TurnResult(
                    case=case.name, role=case.role, text=turn.text, expected=" / ".join(turn.states),
                    end_state=result.end_state, end_reason=result.end_reason, ok=not problems,
                    problems=problems, citations=sorted({c["doc_code"] for c in result.citations}),
                    seconds=seconds, answer=result.content,
                )
            )  # fmt: skip
    variant.llm_calls = counting.calls
    variant.input_tokens = counting.input_tokens
    variant.output_tokens = counting.output_tokens
    return variant


def render(variants: Sequence[VariantResult], estimate_usd: float | None) -> str:
    date = datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        f"# 助手真实检查（{date}）",
        "",
        f"每个版本问 {len(variants[0].turns)} 轮（{len(CASES)} 组场景），真实调用模型。",
        "",
    ]
    lines += [
        "## 版本",
        "",
        "| 版本 | 理解 | 重排 | 生成 | 通过 | 模型调用 | 输入 token | 输出 token | 估算费用 |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for v in variants:
        spent = sum(
            c or 0 for c in (cost_usd(v.models["generate"], v.input_tokens, v.output_tokens),)
        )
        lines.append(
            f"| {v.label} | `{v.models['understand']}` | `{v.models['rerank']}` | `{v.models['generate']}` | "
            f"{v.passed}/{len(v.turns)} | {v.llm_calls} | {v.input_tokens} | {v.output_tokens} | 约 {spent:.4f} 美元（按生成模型的标价粗估） |"
        )
    lines += ["", "估算与实际的偏差见各运行；价格来自第三方价格表或记忆，仅供参考。", ""]
    lines += [
        "## 逐题结果",
        "",
        "| 场景 | 角色 | 期望 | " + " | ".join(f"{v.label}" for v in variants) + " |",
        "|---|---|---|" + "---|" * len(variants),
    ]
    for i, base in enumerate(variants[0].turns):
        cells = []
        for v in variants:
            t = v.turns[i]
            mark = "✅" if t.ok else "❌"
            cells.append(f"{mark} {t.end_state}/{t.end_reason or '-'} ({t.seconds:.1f}s)")
        lines.append(f"| {base.case} | {base.role} | {base.expected} | " + " | ".join(cells) + " |")
    problems = [(v.label, t) for v in variants for t in v.turns if not t.ok]
    lines += ["", "## 没有通过的", ""]
    lines += [f"- **{label}** — {t.case}：{'；'.join(t.problems)}" for label, t in problems] or [
        "无。"
    ]
    lines += ["", "## 回答摘录", ""]
    for i, base in enumerate(variants[0].turns):
        lines.append(f"### {base.case}（{base.role}）")
        lines.append(f"问：{base.text}")
        for v in variants:
            t = v.turns[i]
            snippet = re.sub(r"\s+", " ", t.answer)[:420]
            cites = f"（引用：{', '.join(t.citations)}）" if t.citations else ""
            lines.append(f"- **{v.label}**：{snippet}{cites}")
        lines.append("")
    lines += [
        "## 局限",
        "",
        "- 这是一次抽查，不是评测：每个场景只问一次，模型的回答每次可能略有不同。",
        "- 判定只看结束状态和答案里是否含有关键事实，不判断措辞或完整性；摘录供人工阅读。",
        "- 样本很小，不能据此断定两个模型的优劣，只能看出在这些难题上有没有明显差别。",
        f"- 开始前的估算上限约 {estimate_usd if estimate_usd is not None else '未知'} 美元（每个版本）。",
        "",
    ]
    return "\n".join(lines)


def write(out_dir: Path, variants: Sequence[VariantResult], estimate_usd: float | None) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"agent-check-{datetime.now(UTC).strftime('%Y%m%d-%H%M')}.md"
    path.write_text(render(variants, estimate_usd), encoding="utf-8")
    return path


def summarize_for_console(variants: Sequence[VariantResult]) -> str:
    rows: list[Any] = []
    for v in variants:
        rows.append(
            f"{v.label}: {v.passed}/{len(v.turns)} passed, {v.llm_calls} model calls, {v.input_tokens} in / {v.output_tokens} out tokens"
        )
    return "\n".join(rows)
