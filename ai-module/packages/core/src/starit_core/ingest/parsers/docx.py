"""Word documents.

Uses the Title / Heading styles, list styles and tables. When a file has no heading styles at
all, a short, fully bold, numbered paragraph is taken as a section heading instead.
"""

import re
from pathlib import Path

from docx import Document
from docx.oxml.ns import qn
from docx.table import Table
from docx.text.paragraph import Paragraph

from starit_core.ingest.models import Block, ParsedDocument
from starit_core.ingest.parsers.base import ParseError
from starit_core.ingest.parsers.common import is_metadata_table, table_block

_HEADING_STYLE = re.compile(r"^Heading (\d)$")
_NUMBERED_HEADING = re.compile(r"^\d+(\.\d+)*\.?\s+\S")


class DocxParser:
    def parse(self, path: Path) -> ParsedDocument:
        try:
            document = Document(str(path))
        except Exception as exc:  # python-docx raises several unrelated types on bad input
            raise ParseError(f"cannot read {path.name} as a Word document: {exc}") from exc

        items: list[Paragraph | Table] = []
        for child in document.element.body.iterchildren():
            if child.tag == qn("w:p"):
                items.append(Paragraph(child, document))
            elif child.tag == qn("w:tbl"):
                items.append(Table(child, document))

        has_heading_styles = any(
            isinstance(i, Paragraph) and _HEADING_STYLE.match(_style_name(i)) for i in items
        )
        title: str | None = None
        blocks: list[Block] = []
        for item in items:
            if isinstance(item, Table):
                rows = [[cell.text for cell in row.cells] for row in item.rows]
                if is_metadata_table(rows):
                    continue
                block = table_block(rows)
                if block:
                    blocks.append(block)
                continue
            text = item.text.strip()
            if not text:
                continue
            style = _style_name(item)
            heading = _HEADING_STYLE.match(style)
            if style == "Title":
                title = title or text
            elif heading:
                blocks.append(Block("heading", text, level=1 if int(heading.group(1)) == 1 else 2))
            elif style.startswith("List"):
                blocks.append(Block("list_item", text))
            elif not has_heading_styles and self._looks_like_heading(item, text):
                level = 1 + text.split()[0].rstrip(".").count(".")
                blocks.append(Block("heading", text, level=min(level, 2)))
            else:
                blocks.append(Block("paragraph", text))
        return ParsedDocument(title=title, blocks=blocks)

    @staticmethod
    def _looks_like_heading(paragraph: Paragraph, text: str) -> bool:
        runs = [r for r in paragraph.runs if r.text.strip()]
        return (
            bool(runs)
            and all(r.bold for r in runs)
            and len(text) <= 90
            and bool(_NUMBERED_HEADING.match(text))
        )


def _style_name(paragraph: Paragraph) -> str:
    style = paragraph.style
    return (style.name if style is not None else "") or ""
