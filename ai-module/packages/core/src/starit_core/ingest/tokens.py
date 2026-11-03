"""Token counting with the tokenizer used by the OpenAI embedding models."""

from functools import lru_cache

import tiktoken


@lru_cache(maxsize=1)
def _encoding() -> tiktoken.Encoding:
    # The vocabulary is downloaded on first use and cached.
    return tiktoken.get_encoding("cl100k_base")


def count_tokens(text: str) -> int:
    return len(_encoding().encode(text, disallowed_special=()))


def truncate_to_tokens(text: str, limit: int) -> str:
    """The start of `text`, at most `limit` tokens long."""
    tokens = _encoding().encode(text, disallowed_special=())
    return text if len(tokens) <= limit else _encoding().decode(tokens[:limit])
