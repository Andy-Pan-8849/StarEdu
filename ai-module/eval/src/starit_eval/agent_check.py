"""文件：agent_check.py
作用：对助手做一次“抽查”——用十几道有代表性的问题真实运行，看它在难点上的表现。
这是抽查，不是基准测试：挑的是难例——计算、旧版本政策、相似的错误码、受限文档、无答案的问题、
需要反问的问题，以及必须拒绝的请求。
每个案例（Case）有一到几轮对话（Turn），每轮声明：必须到达的结局、原因、
  回答里必须包含和不能包含的内容、
不能引用的受限文档。
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
    """一轮对话的期望：states 里任意一个结局都算通过；contains/excludes
    是回答里必须有/不能有的词（不分大小写）；forbidden_docs 是不能被引用的受限文档。
    """

    text: str
    states: tuple[str, ...]  # any of these end states is a pass
    reasons: tuple[str | None, ...] | None = None
    contains: tuple[str, ...] = ()  # facts the answer must contain (case-insensitive)
    excludes: tuple[str, ...] = ()
    forbidden_docs: tuple[str, ...] = ()  # documents the answer must not cite (restricted ones)


@dataclass(frozen=True)
class Case:
    """一个案例：名称、提问角色、若干轮对话，以及说明（为什么选它）。"""

    name: str
    role: str
    turns: tuple[Turn, ...]
    note: str = ""


# 案例清单：每个案例对应一种已知的难点（比如小模型曾经把迟交扣分算错）
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
                ("no_permission",),
                ("restricted_data",),
            ),
        ),
        "A manager of another campus: the query is refused before it runs (M6).",
    ),
)


@dataclass
class TurnResult:
    """一轮对话的实际结果和发现的问题。"""

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
    """同一批案例用某一种配置(变体，比如不同模型)跑完的结果。"""

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
    """包住聊天客户端，统计调用次数和 token，用来核对费用。"""

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
    """给一轮对话找问题：结局和原因是否符合期望、必须包含/不能包含的词、是否引用了受限文档。
    返回问题列表（空表示通过）。
    """
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
    cited = {c["doc_code"] for c in result.citations}
    problems += [
        f"cites the restricted document {doc}" for doc in turn.forbidden_docs if doc in cited
    ]
    return problems


def estimate_calls(cases: Sequence[Case]) -> dict[str, int]:
    """一遍案例要调用模型的次数，按步骤分（上限，不含重试）。"""
    understand = sum(len(c.turns) for c in cases)
    searching = sum(
        1 for c in cases for t in c.turns if "answered" in t.states and t.text != "Hi!"
    ) + sum(1 for c in cases for t in c.turns if "no_permission" in t.states)
    return {"understand": understand, "rerank": searching, "generate": searching}


def estimate_cost(
    settings: Settings, calls: dict[str, int], avg_chunk_tokens: int, generate_model: str
) -> float | None:
    """按标价估算费用；有模型没标价则返回 None。"""
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
    """用一种配置把所有案例跑一遍（每个案例新开会话），返回 VariantResult。"""
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
    """生成中文 Markdown 报告：每个案例每一轮的结局、回答和发现的问题。"""
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
    """写报告文件，返回路径。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"agent-check-{datetime.now(UTC).strftime('%Y%m%d-%H%M')}.md"
    path.write_text(render(variants, estimate_usd), encoding="utf-8")
    return path


def summarize_for_console(variants: Sequence[VariantResult]) -> str:
    """控制台上的摘要。"""
    rows: list[Any] = []
    for v in variants:
        rows.append(
            f"{v.label}: {v.passed}/{len(v.turns)} passed, {v.llm_calls} model calls, {v.input_tokens} in / {v.output_tokens} out tokens"
        )
    return "\n".join(rows)
