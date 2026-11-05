"""文件：retrieval/assemble.py
作用：检索的最后一步——从排好序的候选里挑出真正放进提示词的文本块。
主要思想：按名次依次取，直到数量达到 final_k 或累计 token 超过预算；
重复的块（同一个 ID 或文本相同）跳过；第一块即使单独超预算也保留，避免空上下文。
"""

import re
from collections.abc import Sequence

from starit_core.retrieval.models import Candidate

_WHITESPACE = re.compile(r"\s+")


def assemble(
    candidates: Sequence[Candidate], *, final_k: int, budget_tokens: int
) -> list[Candidate]:
    """按排名挑选放进提示词的文本块。

    参数：
      candidates：已排好序（最相关在前）的候选。
      final_k：最多取几块。
      budget_tokens：所有块的 token 总预算。
    返回：被选中的块，顺序不变。
    """
    chosen: list[Candidate] = []
    seen_ids = set()
    seen_text = set()
    used = 0
    for candidate in candidates:
        # 文本相同的判断：忽略空白差异和大小写
        key = _WHITESPACE.sub(" ", candidate.text).strip().lower()
        if candidate.chunk_id in seen_ids or key in seen_text:
            continue
        # 已选了至少一块、再加就超预算：停止（第一块不受此限制）
        if chosen and used + candidate.token_count > budget_tokens:
            break
        chosen.append(candidate)
        seen_ids.add(candidate.chunk_id)
        seen_text.add(key)
        used += candidate.token_count
        if len(chosen) >= final_k:
            break
    return chosen
