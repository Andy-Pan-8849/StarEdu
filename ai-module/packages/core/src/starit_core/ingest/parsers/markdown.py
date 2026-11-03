"""Markdown files (with the metadata block between --- lines removed)."""

import re
from pathlib import Path

from markdown_it import MarkdownIt
from markdown_it.token import Token

from starit_core.ingest.models import Block, ParsedDocument
from starit_core.ingest.parsers.base import ParseError
from starit_core.ingest.parsers.common import strip_emphasis, table_block

_FRONT_MATTER = re.compile(r"\A---\n.*?\n---\n", re.DOTALL)


class MarkdownParser:
    def parse(self, path: Path) -> ParsedDocument:
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
