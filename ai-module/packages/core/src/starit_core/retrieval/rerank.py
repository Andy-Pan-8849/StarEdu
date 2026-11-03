"""Reranking: ask a model to order the candidates by how well they answer the question.

The model sees numbered passages and returns JSON with the numbers in order, best first.
Reranking only reorders chunks the caller was already allowed to read. If the model fails or
answers badly, the fused order is kept and the result is marked, so one bad answer from a model
never turns into a failed search.
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
    order: list[int]  # indexes into the candidate list, best first; always a permutation
    scores: dict[int, float] = field(default_factory=dict)
    input_tokens: int = 0
    output_tokens: int = 0
    failed: bool = False
    partial: bool = False
    error: str | None = None


class Reranker(Protocol):
    async def rerank(self, query: str, candidates: Sequence[Candidate]) -> RerankOutcome: ...


class RerankParseError(ValueError):
    """The model's answer could not be read as a ranking."""


def build_messages(
    query: str, candidates: Sequence[Candidate], passage_tokens: int
) -> list[dict[str, str]]:
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
    """Read the model's answer. Returns (order, scores, partial).

    Ids that are out of range or repeated are ignored; ids the model left out are appended in
    their original order (partial). If nothing usable is found, raises RerankParseError.
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
    def __init__(self, client: ChatClient, model: str, passage_tokens: int = 350) -> None:
        self._client = client
        self._model = model
        self._passage_tokens = passage_tokens

    async def rerank(self, query: str, candidates: Sequence[Candidate]) -> RerankOutcome:
        keep_order = list(range(len(candidates)))
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
