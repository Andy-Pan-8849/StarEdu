"""PDF files, using font sizes to find headings and pdfplumber's table detection.

Headings are lines set larger than the body text. Tables are detected on the page, removed from
the text flow and kept whole. Lines are joined into paragraphs and list items by their layout.
"""

import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pdfplumber

from starit_core.ingest.models import Block, ParsedDocument
from starit_core.ingest.parsers.base import ParseError
from starit_core.ingest.parsers.common import is_metadata_table, table_block

_LIST_MARKER = re.compile(r"^(?:[•·●▪\-–]|\d+[.)])\s+")
_TITLE_RATIO = 1.6  # at least this much larger than body text: the document title
_SECTION_RATIO = 1.2  # section heading
_SUBSECTION_RATIO = 1.05  # sub-heading, only when bold
_MAX_HEADING_CHARS = 100


@dataclass
class _Line:
    page: int
    top: float
    bottom: float
    text: str
    size: float
    bold: bool


class PdfParser:
    def parse(self, path: Path) -> ParsedDocument:
        try:
            with pdfplumber.open(str(path)) as pdf:
                items = self._collect(pdf)
        except Exception as exc:  # pdfminer raises several unrelated types on bad input
            raise ParseError(f"cannot read {path.name} as a PDF: {exc}") from exc
        if not items:
            raise ParseError(f"{path.name} has no extractable text")
        return self._assemble(items)

    @staticmethod
    def _collect(pdf: Any) -> list[tuple[int, float, str, Any]]:
        """Lines and tables of every page as (page, top, kind, payload), in reading order."""
        items: list[tuple[int, float, str, Any]] = []
        for number, page in enumerate(pdf.pages, start=1):
            tables = page.find_tables()
            boxes = [t.bbox for t in tables]

            def outside_tables(obj: dict[str, Any], boxes: list[Any] = boxes) -> bool:
                if obj.get("object_type") != "char":
                    return True
                cx, cy = (obj["x0"] + obj["x1"]) / 2, (obj["top"] + obj["bottom"]) / 2
                return not any(b[0] <= cx <= b[2] and b[1] <= cy <= b[3] for b in boxes)

            for line in page.filter(outside_tables).extract_text_lines(
                return_chars=True, strip=True
            ):
                chars = [c for c in line["chars"] if c["text"].strip()]
                if not chars:
                    continue
                size = max(c["size"] for c in chars)
                bold = sum("bold" in c["fontname"].lower() for c in chars) > len(chars) / 2
                items.append(
                    (number, line["top"], "line",
                     _Line(number, line["top"], line["bottom"], line["text"].strip(), size, bold))
                )  # fmt: skip
            for table in tables:
                items.append((number, table.bbox[1], "table", table.extract()))
        items.sort(key=lambda item: (item[0], item[1]))
        return items

    @staticmethod
    def _assemble(items: list[tuple[int, float, str, Any]]) -> ParsedDocument:
        sizes: Counter[float] = Counter()
        for _page, _top, kind, payload in items:
            if kind == "line":
                sizes[round(payload.size, 1)] += len(payload.text)
        body = sizes.most_common(1)[0][0] if sizes else 11.0

        title: str | None = None
        blocks: list[Block] = []
        previous: _Line | None = None
        for page, _top, kind, payload in items:
            if kind == "table":
                previous = None
                rows = [[cell or "" for cell in row] for row in payload]
                if is_metadata_table(rows):
                    continue
                block = table_block(rows, page)
                if block:
                    blocks.append(block)
                continue
            line: _Line = payload
            ratio = line.size / body
            short = len(line.text) <= _MAX_HEADING_CHARS
            if ratio >= _TITLE_RATIO and title is None:
                title = line.text
                previous = None
            elif short and ratio >= _SECTION_RATIO:
                PdfParser._add_heading(blocks, line, 1, page)
                previous = None
            elif short and ratio >= _SUBSECTION_RATIO and line.bold:
                PdfParser._add_heading(blocks, line, 2, page)
                previous = None
            else:
                PdfParser._add_body(blocks, line, previous, page)
                previous = line
        return ParsedDocument(title=title, blocks=blocks)

    @staticmethod
    def _add_heading(blocks: list[Block], line: _Line, level: int, page: int) -> None:
        # A long heading can wrap onto a second line of the same size.
        if (
            blocks
            and blocks[-1].type == "heading"
            and blocks[-1].level == level
            and blocks[-1].page == page
        ):
            blocks[-1] = Block("heading", f"{blocks[-1].text} {line.text}", level=level, page=page)
        else:
            blocks.append(Block("heading", line.text, level=level, page=page))

    @staticmethod
    def _add_body(blocks: list[Block], line: _Line, previous: _Line | None, page: int) -> None:
        marker = _LIST_MARKER.match(line.text)
        if marker:
            blocks.append(Block("list_item", line.text[marker.end() :], page=page))
            return
        height = max(line.bottom - line.top, 1.0)
        continues = (
            previous is not None
            and previous.page == line.page
            and line.top - previous.bottom < 0.45 * height
            and blocks
            and blocks[-1].type in ("paragraph", "list_item")
        )
        if continues:
            last = blocks[-1]
            # A hyphenated identifier such as FIN-TAX-008 can wrap right after its hyphen. Join
            # without a space so it stays one identifier.
            joiner = "" if re.search(r"[A-Za-z0-9]-$", last.text) else " "
            blocks[-1] = Block(last.type, f"{last.text}{joiner}{line.text}", page=last.page)
        else:
            blocks.append(Block("paragraph", line.text, page=page))
