"""文件：ingest/parsers/pdf.py
作用：解析 PDF 文件。PDF 没有“标题/段落”这种结构，只有一行行带字号的文字，所以要靠版式推断。
算法思想：
  1. 逐页收集：用 pdfplumber 找出表格区域，把落在表格里的字符排除，剩下的按行提取文字
     （记下每行的页码、位置、字号、是否加粗）；表格整块提取；行和表格按（页, 纵向位置）排序，
       还原阅读顺序。
  2. 判断“正文字号”：全文里出现字数最多的字号就是正文字号 body。
  3. 逐行分类，看字号相对正文的倍数：
     - 至少 1.6 倍，且还没有标题 -> 文档标题；
     - 至少 1.2 倍且不太长 -> 章节标题（一级）；
     - 至少 1.05 倍、加粗、不太长 -> 小节标题（二级）；
     - 否则是正文。
  4. 正文行合并成段落：以项目符号/编号开头的行是列表项；
     与上一行同页、行距很小（小于行高的 0.45 倍）就接在上一段后面，否则另起一段。
文档顶部的元数据表丢掉；整份文件提不出文字（如扫描件）则抛 ParseError。
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

# 列表项的开头：项目符号或 "1."、"2)" 这样的编号
_LIST_MARKER = re.compile(r"^(?:[•·●▪\-–]|\d+[.)])\s+")
# 字号相对正文的倍数阈值：标题 / 章节标题 / 小节标题（仅加粗时）
_TITLE_RATIO = 1.6  # at least this much larger than body text: the document title
_SECTION_RATIO = 1.2  # section heading
_SUBSECTION_RATIO = 1.05  # sub-heading, only when bold
# 标题的最大字数，更长的当作正文
_MAX_HEADING_CHARS = 100


@dataclass
class _Line:
    """PDF 里的一行文字：页码、上下边的位置、文字、最大字号、是否加粗（多数字符是粗体字体）。"""

    page: int
    top: float
    bottom: float
    text: str
    size: float
    bold: bool


class PdfParser:
    """PDF 解析器。"""

    def parse(self, path: Path) -> ParsedDocument:
        """读取 PDF，返回结构化文档；打不开抛 ParseError，没有可提取文字也抛 ParseError。"""
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
        """收集每页的文字行和表格，返回 (页码, 纵向位置, 类型, 内容) 的列表，已按阅读顺序排好。"""
        items: list[tuple[int, float, str, Any]] = []
        for number, page in enumerate(pdf.pages, start=1):
            tables = page.find_tables()
            boxes = [t.bbox for t in tables]

            # 过滤函数：只保留中心点不在任何表格区域内的字符，避免表格文字被当成正文重复提取
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
        """把收集到的行和表格按字号分类，组装成文档（算法见文件头）。"""
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
        """加标题。超长标题会折成同字号的两行，此时并入上一个同级同页的标题。"""
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
        """加正文行：列表项单独成块；与上一行紧挨着的接成同一段，否则另起一段。"""
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
            # 连字符编号（如 FIN-TAX-008）可能刚好在连字符后换行：这种情况不加空格，
            #   保持它是一个编号
            joiner = "" if re.search(r"[A-Za-z0-9]-$", last.text) else " "
            blocks[-1] = Block(last.type, f"{last.text}{joiner}{line.text}", page=last.page)
        else:
            blocks.append(Block("paragraph", line.text, page=page))
