"""文件：ingest/tokens.py
作用：用 OpenAI 嵌入模型所用的分词器(cl100k_base)数 token。
切块大小、提示词预算、重排截断都依赖它。分词表首次使用时下载并缓存。
"""

from functools import lru_cache

import tiktoken


@lru_cache(maxsize=1)
def _encoding() -> tiktoken.Encoding:
    # The vocabulary is downloaded on first use and cached.
    return tiktoken.get_encoding("cl100k_base")


def count_tokens(text: str) -> int:
    """文本有多少个 token。"""
    return len(_encoding().encode(text, disallowed_special=()))


def truncate_to_tokens(text: str, limit: int) -> str:
    """取文本开头最多 limit 个 token 的部分。"""
    tokens = _encoding().encode(text, disallowed_special=())
    return text if len(tokens) <= limit else _encoding().decode(tokens[:limit])
