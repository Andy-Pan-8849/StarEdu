"""Data passed between the ingestion stages."""

from dataclasses import dataclass
from typing import Literal

BlockType = Literal["heading", "paragraph", "list_item", "table", "code"]


@dataclass(frozen=True)
class Block:
    """One structural piece of a document, in reading order.

    Headings carry a level: 1 is a section heading, 2 a sub-section. The document title is kept
    separately in ParsedDocument.title.
    """

    type: BlockType
    text: str
    level: int = 0
    page: int | None = None


@dataclass
class ParsedDocument:
    title: str | None
    blocks: list[Block]


@dataclass(frozen=True)
class Chunk:
    index: int
    text: str
    heading_path: tuple[str, ...]
    page: int | None
    token_count: int
    identifiers: tuple[str, ...] = ()
