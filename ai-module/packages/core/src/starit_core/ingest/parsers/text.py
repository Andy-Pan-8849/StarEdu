"""文件：ingest/parsers/text.py
作用：解析纯文本文件(.txt)。
示例文件的版式：开头是若干 `key: value` 元数据行，空一行，然后是标题，
之后是章节——章节标题是前后各空一行的短行，带编号（如 "2. Valid invoices"）。
主要思想（难点是区分“章节标题”和“列表项”，它们编号方式相同）：
  - 只有“编号恰好等于下一个章节号、独占一行（前后有空行）、不以句末标点结尾、不太长”
    的行才算章节标题；
  - 其余带编号的行是列表项；
  - 章节里独占一行的短行（无编号、不以句末标点结尾）是小标题；
  - 以 | 开头的连续行是表格；其余连续的行合成一个段落。
"""

import re
from pathlib import Path

from starit_core.ingest.models import Block, ParsedDocument
from starit_core.ingest.parsers.base import ParseError
from starit_core.ingest.parsers.common import META_KEYS, table_block

# 元数据行：以 doc_id:、version: 等已知键开头
_META_LINE = re.compile(rf"^({'|'.join(META_KEYS)}):")
# 编号行："3. xxx"
_NUMBERED = re.compile(r"^(\d+)\.\s+(\S.*)$")
# 项目符号行：- * •
_BULLET = re.compile(r"^[-*•]\s+(\S.*)$")
# Markdown 表格的分隔行单元格，如 ---、:---:
_SEPARATOR_CELL = re.compile(r":?-{2,}:?")
# 以这些符号结尾的行更像一句话，而不是标题
_SENTENCE_END = (".", "!", "?", ":", ";")
# 章节标题、小标题的最大长度
_MAX_SECTION_HEADING = 90
_MAX_SUBHEADING = 70


class TextParser:
    """纯文本解析器。"""

    def parse(self, path: Path) -> ParsedDocument:
        """读取 .txt：去元数据行，然后逐行判断它是表格、标题、列表项、小标题还是段落。读不了抛
        ParseError。
        """
        try:
            raw = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            raise ParseError(f"cannot read {path.name}: {exc}") from exc
        lines = raw.replace("\r\n", "\n").split("\n")

        # 跳过开头的元数据行
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
            # alone：这一行前后都是空行（或在文件边界），即“独占一行”
            alone = (i == 0 or not lines[i - 1].strip()) and (
                i + 1 >= len(lines) or not lines[i + 1].strip()
            )
            numbered = _NUMBERED.match(line)
            bullet = _BULLET.match(line)
            if not line.strip():
                i += 1
            # 表格：收集连续的 | 行，跳过分隔行
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
            # 第一个独占一行的无编号行是文档标题
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
                # 其余情况：把连续的非空行合并成一个段落，遇到新块的开头就停
                paragraph = [line.strip()]
                i += 1
                while i < len(lines) and lines[i].strip() and not self._starts_block(lines[i]):
                    paragraph.append(lines[i].strip())
                    i += 1
                blocks.append(Block("paragraph", " ".join(paragraph)))
        return ParsedDocument(title=title, blocks=blocks)

    @staticmethod
    def _is_section_heading(m: re.Match[str], alone: bool, expected: int) -> bool:
        """是不是章节标题：独占一行、编号等于期望的下一个章节号、不太长、不以句末标点结尾。"""
        text = m.group(2)
        return (
            alone
            and int(m.group(1)) == expected
            and len(text) <= _MAX_SECTION_HEADING
            and not text.endswith(_SENTENCE_END)
        )

    @staticmethod
    def _is_subheading(line: str, blocks: list[Block]) -> bool:
        """是不是小标题：不太长、不以句末标点结尾，并且前面已经出现过章节标题。"""
        return (
            len(line) <= _MAX_SUBHEADING
            and not line.endswith(_SENTENCE_END)
            and any(b.type == "heading" for b in blocks)
        )

    @staticmethod
    def _starts_block(line: str) -> bool:
        """这一行是不是一个新块的开头（表格、项目符号或编号），用来决定段落到哪里结束。"""
        return bool(line.startswith("|") or _BULLET.match(line) or _NUMBERED.match(line))
