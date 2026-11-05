"""文件：ingest/parsers/base.py
作用：解析器的共同接口：parse(路径) -> ParsedDocument；失败抛 ParseError。
"""

from pathlib import Path
from typing import Protocol

from starit_core.ingest.models import ParsedDocument


class ParseError(Exception):
    """文件无法按它声称的格式读取（损坏、加密、空文件等）。入库时不会重试。"""


class Parser(Protocol):
    """解析器接口：每种格式实现一个 parse 方法。"""

    def parse(self, path: Path) -> ParsedDocument: ...
