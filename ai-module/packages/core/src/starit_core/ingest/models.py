"""文件：ingest/models.py
作用：入库各阶段之间传递的数据结构。
主要内容：Block（文档的一个结构单元）-> ParsedDocument（解析结果）-> Chunk（切好的文本块）。
"""

from dataclasses import dataclass
from typing import Literal

# 块的类型：标题、段落、列表项、表格、代码
BlockType = Literal["heading", "paragraph", "list_item", "table", "code"]


@dataclass(frozen=True)
class Block:
    """文档里按阅读顺序排列的一个结构单元。

    标题带层级：1 是章节标题，2 是小节标题；文档标题单独放在 ParsedDocument.title 里。
    page 是所在页码（PDF 才有）。
    """

    type: BlockType
    text: str
    level: int = 0
    page: int | None = None


@dataclass
class ParsedDocument:
    """解析的结果：文档标题(可能没有)和按顺序排列的块。"""

    title: str | None
    blocks: list[Block]


@dataclass(frozen=True)
class Chunk:
    """切好的文本块：序号、文字、标题路径(如 章 > 节)、页码、token 数，以及文中出现的编号。"""

    index: int
    text: str
    heading_path: tuple[str, ...]
    page: int | None
    token_count: int
    identifiers: tuple[str, ...] = ()
