"""Structure-aware chunking.

Blocks are laid out in reading order, each section starting with its heading line, and packed
into chunks of at most `max_tokens`. A chunk is only ended at a section boundary once it has
reached `target_tokens`, so short sections are combined into a chunk of useful size (set the
target to 0 for one chunk per section). A heading never ends a chunk: it stays with the text
under it. Tables and code are kept whole; one that is too large is split between rows (or
lines) and each piece repeats the table header (or code fence). When a long section needs
several chunks, the next one starts with the last paragraph or list items of the previous one
(up to `overlap_tokens`) so a sentence at the boundary is seen in both.

A chunk's heading path is that of its first block; its text includes every heading it covers.
"""

import re
from collections.abc import Callable
from dataclasses import dataclass

from starit_core.ingest.identifiers import extract_identifiers
from starit_core.ingest.models import Block, Chunk, ParsedDocument
from starit_core.ingest.tokens import count_tokens

_SEPARATOR_TOKENS = 2  # the blank line between blocks
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")


@dataclass
class _Section:
    path: tuple[str, ...]
    heading: str | None
    blocks: list[Block]


@dataclass
class _Unit:
    kind: str  # "heading" or a block type
    text: str
    tokens: int
    page: int | None
    path: tuple[str, ...]


def chunk_document(
    doc: ParsedDocument,
    *,
    doc_code: str,
    target_tokens: int = 400,
    max_tokens: int = 500,
    overlap_tokens: int = 50,
    count: Callable[[str], int] = count_tokens,
) -> list[Chunk]:
    units = _units(doc, max_tokens, count)
    chunks: list[Chunk] = []

    def emit(parts: list[_Unit]) -> None:
        text = "\n\n".join(u.text for u in parts)
        chunks.append(
            Chunk(
                index=len(chunks),
                text=text,
                heading_path=parts[0].path,
                page=next((u.page for u in parts if u.page is not None), None),
                token_count=count(text),
                identifiers=tuple(extract_identifiers(text, extra=[doc_code])),
            )
        )

    current: list[_Unit] = []
    used = 0
    new_units = 0  # units added since the last chunk was emitted (not carried over)
    for unit in units:
        need = unit.tokens + _SEPARATOR_TOKENS
        size_break = new_units > 0 and used + need > max_tokens
        boundary_break = new_units > 0 and unit.kind == "heading" and used >= target_tokens
        if size_break or boundary_break:
            trailing = current.pop() if current and current[-1].kind == "heading" else None
            emitted = current
            if emitted:
                emit(emitted)
            carry = (
                _overlap(emitted, overlap_tokens)
                if trailing is None and not boundary_break and unit.path == emitted[-1].path
                else []
            )
            current = carry + ([trailing] if trailing else [])
            used = sum(u.tokens + _SEPARATOR_TOKENS for u in current)
            new_units = 1 if trailing else 0
            if used + need > max_tokens:  # no room for the carried text and this unit
                current = [trailing] if trailing else []
                used = sum(u.tokens + _SEPARATOR_TOKENS for u in current)
        current.append(unit)
        used += need
        new_units += 1
    if new_units:
        emit(current)
    return chunks


def _units(doc: ParsedDocument, max_tokens: int, count: Callable[[str], int]) -> list[_Unit]:
    units: list[_Unit] = []
    for section in _sections(doc):
        heading_cost = 0
        if section.heading:
            heading_cost = count(section.heading) + _SEPARATOR_TOKENS
            units.append(
                _Unit("heading", section.heading, count(section.heading), None, section.path)
            )
        for block in section.blocks:
            # Leave room for the heading so heading plus first piece always fits in one chunk.
            for text in _split_block(block, max_tokens - heading_cost, count):
                units.append(_Unit(block.type, text, count(text), block.page, section.path))
    return units


def _sections(doc: ParsedDocument) -> list[_Section]:
    sections = [_Section((), None, [])]
    path: list[str] = []
    for block in doc.blocks:
        if block.type == "heading":
            path = [block.text] if block.level <= 1 or not path else [path[0], block.text]
            sections.append(_Section(tuple(path), block.text, []))
        else:
            sections[-1].blocks.append(block)
    return [s for s in sections if s.blocks]


def _overlap(units: list[_Unit], overlap_tokens: int) -> list[_Unit]:
    """Trailing paragraphs or list items up to the overlap budget (never tables or code)."""
    carry: list[_Unit] = []
    total = 0
    for unit in reversed(units):
        if unit.kind not in ("paragraph", "list_item"):
            break
        total += unit.tokens + _SEPARATOR_TOKENS
        if total > overlap_tokens:
            break
        carry.insert(0, unit)
    return carry


def _split_block(block: Block, budget: int, count: Callable[[str], int]) -> list[str]:
    if count(block.text) <= budget:
        return [block.text]
    if block.type == "table":
        return _split_table(block.text, budget, count)
    if block.type == "code":
        return _split_code(block.text, budget, count)
    return _split_prose(block.text, budget, count)


def _split_table(text: str, budget: int, count: Callable[[str], int]) -> list[str]:
    lines = text.split("\n")
    header, rows = lines[:2], lines[2:]
    pieces: list[str] = []
    current: list[str] = []
    for row in rows:
        candidate = "\n".join(header + current + [row])
        if current and count(candidate) > budget:
            pieces.append("\n".join(header + current))
            current = []
        current.append(row)
    if current:
        pieces.append("\n".join(header + current))
    return pieces


def _split_code(text: str, budget: int, count: Callable[[str], int]) -> list[str]:
    lines = text.split("\n")
    fence = lines[0] if lines[0].startswith("```") else "```"
    body = (
        [ln for ln in lines[1:] if not ln.startswith("```")]
        if lines[0].startswith("```")
        else lines
    )
    pieces: list[str] = []
    current: list[str] = []
    for line in body:
        candidate = "\n".join([fence, *current, line, "```"])
        if current and count(candidate) > budget:
            pieces.append("\n".join([fence, *current, "```"]))
            current = []
        current.append(line)
    if current:
        pieces.append("\n".join([fence, *current, "```"]))
    return pieces


def _split_prose(text: str, budget: int, count: Callable[[str], int]) -> list[str]:
    """Split a long paragraph at sentence ends; a single over-long sentence is split at words."""
    pieces: list[str] = []
    current = ""
    for sentence in _SENTENCE_SPLIT.split(text):
        for part in _split_words(sentence, budget, count):
            candidate = f"{current} {part}".strip()
            if current and count(candidate) > budget:
                pieces.append(current)
                current = part
            else:
                current = candidate
    if current:
        pieces.append(current)
    return pieces


def _split_words(text: str, budget: int, count: Callable[[str], int]) -> list[str]:
    if count(text) <= budget:
        return [text]
    pieces: list[str] = []
    current = ""
    for word in text.split():
        candidate = f"{current} {word}".strip()
        if current and count(candidate) > budget:
            pieces.append(current)
            current = word
        else:
            current = candidate
    if current:
        pieces.append(current)
    return pieces
