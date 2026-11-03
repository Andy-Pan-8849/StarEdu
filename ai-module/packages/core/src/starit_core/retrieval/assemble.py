"""Choose the chunks that go into the prompt."""

import re
from collections.abc import Sequence

from starit_core.retrieval.models import Candidate

_WHITESPACE = re.compile(r"\s+")


def assemble(
    candidates: Sequence[Candidate], *, final_k: int, budget_tokens: int
) -> list[Candidate]:
    """Take candidates in rank order until `final_k` or the token budget is reached.

    A chunk that appears twice, or whose text is identical to one already chosen, is skipped. The
    first chunk is always kept, even if it alone is over the budget.
    """
    chosen: list[Candidate] = []
    seen_ids = set()
    seen_text = set()
    used = 0
    for candidate in candidates:
        key = _WHITESPACE.sub(" ", candidate.text).strip().lower()
        if candidate.chunk_id in seen_ids or key in seen_text:
            continue
        if chosen and used + candidate.token_count > budget_tokens:
            break
        chosen.append(candidate)
        seen_ids.add(candidate.chunk_id)
        seen_text.add(key)
        used += candidate.token_count
        if len(chosen) >= final_k:
            break
    return chosen
