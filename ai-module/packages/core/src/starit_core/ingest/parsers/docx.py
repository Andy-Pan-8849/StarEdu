"""文件：ingest/parsers/docx.py
作用：解析 Word 文档(.docx)。
主要思想：优先用 Word 自带的样式——Title(文档标题)、Heading 1/2(章节标题)、List(列表)、表格；
如果文件完全没有标题样式，就退而求其次：把“较短、整段加粗、以数字编号开头”的段落当作章节标题。
文档顶部的元数据表(Document ID …)与清单重复，直接丢掉。
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

# 匹配样式名 Heading 1、Heading 2 …
_HEADING_STYLE = re.compile(r"^Heading (\d)$")
# 匹配以数字编号开头的行，如 "2. Valid invoices"、"3.1 Scope"
_NUMBERED_HEADING = re.compile(r"^\d+(\.\d+)*\.?\s+\S")


class DocxParser:
    """Word 解析器。"""

    def parse(self, path: Path) -> ParsedDocument:
        """读取 .docx，按文档里的顺序产出标题、段落、列表项、表格块。文件读不了抛 ParseError。"""
        try:
            document = Document(str(path))
        except Exception as exc:  # python-docx raises several unrelated types on bad input
            raise ParseError(f"cannot read {path.name} as a Word document: {exc}") from exc

        # 按文档里出现的顺序，把段落和表格取出来（python-docx 的 API 默认把它们分开，会乱序）
        items: list[Paragraph | Table] = []
        for child in document.element.body.iterchildren():
            if child.tag == qn("w:p"):
                items.append(Paragraph(child, document))
            elif child.tag == qn("w:tbl"):
                items.append(Table(child, document))

        # 文件里有没有用标题样式：决定要不要启用“加粗编号行当标题”的兜底规则
        has_heading_styles = any(
            isinstance(i, Paragraph) and _HEADING_STYLE.match(_style_name(i)) for i in items
        )
        title: str | None = None
        blocks: list[Block] = []
        # 逐项转换成 Block：表格 / Title / Heading / List / 兜底标题 / 普通段落
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
        """兜底规则：全部文字加粗、不超过 90 字、以数字编号开头，就当作标题。"""
        runs = [r for r in paragraph.runs if r.text.strip()]
        return (
            bool(runs)
            and all(r.bold for r in runs)
            and len(text) <= 90
            and bool(_NUMBERED_HEADING.match(text))
        )


def _style_name(paragraph: Paragraph) -> str:
    """段落的样式名，没有样式时返回空串。"""
    style = paragraph.style
    return (style.name if style is not None else "") or ""
