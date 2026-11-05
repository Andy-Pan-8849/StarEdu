"""文件：ingest/parsers/markdown.py
作用：解析 Markdown 文件(.md)。
主要思想：用 markdown-it 把文本解析成 token 流，再按 token 类型转成块：
一级标题第一次出现当作文档标题，其余标题降一级(# -> 章节, ## -> 小节)，
列表里的段落是 list_item，表格转 Markdown 表，代码块保留围栏。
开头 --- 之间的元数据块会先被去掉。
"""

import re
from pathlib import Path

from markdown_it import MarkdownIt
from markdown_it.token import Token

from starit_core.ingest.models import Block, ParsedDocument
from starit_core.ingest.parsers.base import ParseError
from starit_core.ingest.parsers.common import strip_emphasis, table_block

# 开头用 --- 包起来的元数据块（只在文件最开头匹配一次）
_FRONT_MATTER = re.compile(r"\A---\n.*?\n---\n", re.DOTALL)


class MarkdownParser:
    """Markdown 解析器。"""

    def parse(self, path: Path) -> ParsedDocument:
        """读取 .md，去元数据、解析 token 并转成块。读不了（编码或权限问题）抛 ParseError。"""
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            raise ParseError(f"cannot read {path.name}: {exc}") from exc
        text = _FRONT_MATTER.sub("", text, count=1)
        tokens = MarkdownIt("commonmark").enable("table").parse(text)

        title: str | None = None
        blocks: list[Block] = []
        list_depth = 0
        i = 0
        # 顺序扫描 token：heading_open 后面跟着 inline 内容再 heading_close，所以一次前进 3 个
        while i < len(tokens):
            token = tokens[i]
            if token.type == "heading_open":
                level, content = int(token.tag[1]), strip_emphasis(tokens[i + 1].content)
                if level == 1 and title is None:
                    title = content
                else:
                    blocks.append(Block("heading", content, level=min(max(level - 1, 1), 2)))
                i += 3
            elif token.type in ("bullet_list_open", "ordered_list_open"):
                list_depth += 1
                i += 1
            elif token.type in ("bullet_list_close", "ordered_list_close"):
                list_depth -= 1
                i += 1
            elif token.type == "paragraph_open":
                content = strip_emphasis(tokens[i + 1].content)
                blocks.append(Block("list_item" if list_depth else "paragraph", content))
                i += 3
            elif token.type == "table_open":
                i = self._table(tokens, i, blocks)
            elif token.type in ("fence", "code_block"):
                info = token.info.strip() if token.type == "fence" else ""
                blocks.append(Block("code", f"```{info}\n{token.content.rstrip()}\n```"))
                i += 1
            else:
                i += 1
        return ParsedDocument(title=title, blocks=blocks)

    @staticmethod
    def _table(tokens: list[Token], start: int, blocks: list[Block]) -> int:
        """从 table_open 读到 table_close，收集每行每格文字，生成表格块。
        参数：tokens 全部 token；start 表格开始处；blocks 产出的块列表（直接追加）。
        返回：表格结束之后的下一个 token 位置。
        """
        rows: list[list[str]] = []
        i = start
        while tokens[i].type != "table_close":
            if tokens[i].type == "tr_open":
                rows.append([])
            elif tokens[i].type == "inline":
                rows[-1].append(strip_emphasis(tokens[i].content))
            i += 1
        block = table_block(rows)
        if block:
            blocks.append(block)
        return i + 1
