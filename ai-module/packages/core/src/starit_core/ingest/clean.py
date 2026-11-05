"""文件：ingest/clean.py
作用：整理解析出来的文字，只整理、不改写内容。
做什么：去掉零宽字符、统一换行和空白；丢掉空块；
丢掉在多页重复出现的段落（页眉页脚，PDF 常见）；丢掉空标题。
"""

import re
from collections import Counter
from dataclasses import replace

from starit_core.ingest.models import Block, ParsedDocument

# 要去掉的不可见字符（零宽空格、零宽连接符、BOM 等）
_INVISIBLE = dict.fromkeys(map(ord, "​‌‍⁠﻿"), None)
# 一行里连续的空格、制表符、不换行空格 -> 一个空格
_SPACES = re.compile(r"[ \t ]+")


def clean_text(text: str) -> str:
    """整理一段文字：去不可见字符、统一换行、压缩每行内的空白、去首尾空白。"""
    text = text.translate(_INVISIBLE).replace("\r\n", "\n").replace("\r", "\n")
    lines = [_SPACES.sub(" ", line).strip() for line in text.split("\n")]
    return "\n".join(lines).strip()


def clean_document(doc: ParsedDocument) -> ParsedDocument:
    """整理整份文档。

    PDF 页眉页脚的识别：当文档有至少 3 页时，同一段文字出现在 3 页及以上就视为页眉/页脚，丢弃。
    """
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
    """去掉清理后变成空的标题。"""
    return [b for b in blocks if b.type != "heading" or b.text]
