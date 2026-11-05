"""文件：retrieval/rerank.py
作用：重排——让模型按“对回答问题有多大帮助”给候选重新排序。
主要思想：把编号的段落发给模型，要求只回 JSON（按好坏排好的编号和 0-10 分）。
重排只重新排列用户本来就有权读的块；如果模型失败或回答无法解析，
保留融合后的顺序并标记失败，所以模型的一次出错不会让整次检索失败。
对旧版本（superseded）的文档不特别惩罚，只是同一政策的现行版应排在它前面。
"""

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from starit_core.ingest.tokens import truncate_to_tokens
from starit_core.llm import ChatClient, ChatError
from starit_core.retrieval.models import Candidate

SYSTEM_PROMPT = """You rank passages by how well they help answer a question.
Reply with JSON only, in this shape: {"ranking": [{"id": 3, "score": 9}, {"id": 1, "score": 4}]}
List every passage id once, best first. The score is 0 to 10: 10 means the passage answers the
question directly, 0 means it is irrelevant. Judge only by the passage text. A passage marked
"superseded" is an old version of a policy: rank it by relevance like any other, and the active
version of the same policy should come before it unless the question asks about the old version."""


@dataclass
class RerankOutcome:
    """一次重排的结果。order 是候选下标的排列（最好的在前，永远是完整排列）；
    failed 表示模型出错或回答不可用（此时 order 保持原顺序）；partial 表示模型漏了一部分编号。
    """

    order: list[int]  # indexes into the candidate list, best first; always a permutation
    scores: dict[int, float] = field(default_factory=dict)
    input_tokens: int = 0
    output_tokens: int = 0
    failed: bool = False
    partial: bool = False
    error: str | None = None


class Reranker(Protocol):
    """重排器的接口（协议）：评测里可以换成假实现。"""

    async def rerank(self, query: str, candidates: Sequence[Candidate]) -> RerankOutcome: ...


class RerankParseError(ValueError):
    """The model's answer could not be read as a ranking."""


def build_messages(
    query: str, candidates: Sequence[Candidate], passage_tokens: int
) -> list[dict[str, str]]:
    """生成发给模型的消息：系统提示 + 带编号的段落。

    参数：query 用户问题；candidates 候选；
    passage_tokens 每段最多保留多少 token（超出截断，控制成本）。
    """
    passages = []
    for number, c in enumerate(candidates, start=1):
        where = " > ".join(c.heading_path)
        header = f"[{number}] {c.doc_code} v{c.version} ({c.status}) - {c.title}"
        if where:
            header += f" - {where}"
        passages.append(f"{header}\n{truncate_to_tokens(c.text, passage_tokens)}")
    user = f"Question: {query}\n\nPassages:\n\n" + "\n\n".join(passages)
    return [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}]


_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)


def parse_ranking(text: str, count: int) -> tuple[list[int], dict[int, float], bool]:
    """读取模型返回的排名。

    参数：text 模型原始回答（可带 ```json 围栏）；count 候选数量。
    返回：(order, scores, partial)——order 是候选下标排列，scores 是 {下标: 模型打分}，
    partial 为 True 表示模型漏了某些编号（漏的按原顺序补在后面）。
    越界或重复的编号忽略；一个有效编号都没有就抛 RerankParseError。
    """
    try:
        data: Any = json.loads(_FENCE.sub("", text.strip()))
    except json.JSONDecodeError as exc:
        raise RerankParseError(f"not valid JSON: {exc.msg}") from exc
    items = data.get("ranking") if isinstance(data, dict) else data
    if not isinstance(items, list):
        raise RerankParseError("no ranking list in the answer")

    order: list[int] = []
    scores: dict[int, float] = {}
    for item in items:
        raw_id = item.get("id") if isinstance(item, dict) else item
        raw_score = item.get("score") if isinstance(item, dict) else None
        if raw_id is None or isinstance(raw_id, bool):
            continue
        try:
            index = int(raw_id) - 1
        except (TypeError, ValueError):
            continue
        if not 0 <= index < count or index in order:
            continue
        order.append(index)
        if isinstance(raw_score, int | float) and not isinstance(raw_score, bool):
            scores[index] = float(raw_score)
    if not order:
        raise RerankParseError("the ranking has no valid passage ids")
    missing = [i for i in range(count) if i not in order]
    return order + missing, scores, bool(missing)


class LLMReranker:
    """用聊天模型做重排。出错时不抛异常，而是返回 failed=True 并保持原顺序。"""

    def __init__(self, client: ChatClient, model: str, passage_tokens: int = 350) -> None:
        self._client = client
        self._model = model
        self._passage_tokens = passage_tokens

    async def rerank(self, query: str, candidates: Sequence[Candidate]) -> RerankOutcome:
        keep_order = list(range(len(candidates)))
        # 少于 2 个候选没有排序的意义，省一次模型调用
        if len(candidates) < 2:
            return RerankOutcome(order=keep_order)
        messages = build_messages(query, candidates, self._passage_tokens)
        try:
            result = await self._client.complete(messages, model=self._model, json_mode=True)
        except ChatError as exc:
            return RerankOutcome(order=keep_order, failed=True, error=str(exc))
        try:
            order, scores, partial = parse_ranking(result.text, len(candidates))
        except RerankParseError as exc:
            return RerankOutcome(
                order=keep_order,
                input_tokens=result.input_tokens,
                output_tokens=result.output_tokens,
                failed=True,
                error=str(exc),
            )
        return RerankOutcome(
            order=order,
            scores=scores,
            input_tokens=result.input_tokens,
            output_tokens=result.output_tokens,
            partial=partial,
        )
