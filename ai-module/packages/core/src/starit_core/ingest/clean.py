"""Tidy extracted text without rewriting it."""

import re
from collections import Counter
from dataclasses import replace

from starit_core.ingest.models import Block, ParsedDocument

_INVISIBLE = dict.fromkeys(map(ord, "​‌‍⁠﻿"), None)
_SPACES = re.compile(r"[ \t ]+")


def clean_text(text: str) -> str:
    text = text.translate(_INVISIBLE).replace("\r\n", "\n").replace("\r", "\n")
    lines = [_SPACES.sub(" ", line).strip() for line in text.split("\n")]
    return "\n".join(lines).strip()


def clean_document(doc: ParsedDocument) -> ParsedDocument:
    """Normalise whitespace; drop empty blocks and lines repeated on many pages."""
    blocks = [replace(b, text=clean_text(b.text)) for b in doc.blocks]
    blocks = [b for b in blocks if b.text]
    pages = {b.page for b in blocks if b.page is not None}
    if len(pages) >= 3:
        seen: Counter[str] = Counter()
        for page in pages:
            for text in {b.text for b in blocks if b.page == page and b.type == "paragraph"}:
                seen[text] += 1
        repeated = {text for text, n in seen.items() if n >= 3}
        blocks = [b for b in blocks if not (b.type == "paragraph" and b.text in repeated)]
    title = clean_text(doc.title) if doc.title else None
    return ParsedDocument(title=title or None, blocks=_drop_empty_headings(blocks))


def _drop_empty_headings(blocks: list[Block]) -> list[Block]:
    return [b for b in blocks if b.type != "heading" or b.text]
