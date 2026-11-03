"""Plain-text files.

Layout of the sample files: a `key: value` metadata block, a blank line, the title, then
sections whose headings are short numbered lines ("2. Valid invoices") with a blank line before
and after. List items use the same numbering, so a numbered line only counts as a section
heading when it carries the next section number and stands alone. A short unnumbered line
standing alone inside a section is a sub-heading.
"""

import re
from pathlib import Path

from starit_core.ingest.models import Block, ParsedDocument
from starit_core.ingest.parsers.base import ParseError
from starit_core.ingest.parsers.common import META_KEYS, table_block

_META_LINE = re.compile(rf"^({'|'.join(META_KEYS)}):")
_NUMBERED = re.compile(r"^(\d+)\.\s+(\S.*)$")
_BULLET = re.compile(r"^[-*•]\s+(\S.*)$")
_SEPARATOR_CELL = re.compile(r":?-{2,}:?")
_SENTENCE_END = (".", "!", "?", ":", ";")
_MAX_SECTION_HEADING = 90
_MAX_SUBHEADING = 70


class TextParser:
    def parse(self, path: Path) -> ParsedDocument:
        try:
            raw = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            raise ParseError(f"cannot read {path.name}: {exc}") from exc
        lines = raw.replace("\r\n", "\n").split("\n")

        start = 0
        while start < len(lines) and _META_LINE.match(lines[start]):
            start += 1
        lines = lines[start:]

        title: str | None = None
        blocks: list[Block] = []
        next_section = 1
        i = 0
        while i < len(lines):
            line = lines[i].rstrip()
            alone = (i == 0 or not lines[i - 1].strip()) and (
                i + 1 >= len(lines) or not lines[i + 1].strip()
            )
            numbered = _NUMBERED.match(line)
            bullet = _BULLET.match(line)
            if not line.strip():
                i += 1
            elif line.startswith("|"):
                rows: list[list[str]] = []
                while i < len(lines) and lines[i].startswith("|"):
                    cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                    if not all(_SEPARATOR_CELL.fullmatch(c) for c in cells):
                        rows.append(cells)
                    i += 1
                block = table_block(rows)
                if block:
                    blocks.append(block)
            elif title is None and alone and not numbered:
                title = line.strip()
                i += 1
            elif numbered and self._is_section_heading(numbered, alone, next_section):
                blocks.append(Block("heading", line.strip(), level=1))
                next_section += 1
                i += 1
            elif bullet:
                blocks.append(Block("list_item", bullet.group(1)))
                i += 1
            elif numbered:
                blocks.append(Block("list_item", numbered.group(2)))
                i += 1
            elif alone and self._is_subheading(line, blocks):
                blocks.append(Block("heading", line.strip(), level=2))
                i += 1
            else:
                paragraph = [line.strip()]
                i += 1
                while i < len(lines) and lines[i].strip() and not self._starts_block(lines[i]):
                    paragraph.append(lines[i].strip())
                    i += 1
                blocks.append(Block("paragraph", " ".join(paragraph)))
        return ParsedDocument(title=title, blocks=blocks)

    @staticmethod
    def _is_section_heading(m: re.Match[str], alone: bool, expected: int) -> bool:
        text = m.group(2)
        return (
            alone
            and int(m.group(1)) == expected
            and len(text) <= _MAX_SECTION_HEADING
            and not text.endswith(_SENTENCE_END)
        )

    @staticmethod
    def _is_subheading(line: str, blocks: list[Block]) -> bool:
        return (
            len(line) <= _MAX_SUBHEADING
            and not line.endswith(_SENTENCE_END)
            and any(b.type == "heading" for b in blocks)
        )

    @staticmethod
    def _starts_block(line: str) -> bool:
        return bool(line.startswith("|") or _BULLET.match(line) or _NUMBERED.match(line))
