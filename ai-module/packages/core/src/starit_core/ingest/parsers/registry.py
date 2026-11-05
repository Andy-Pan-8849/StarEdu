"""文件：ingest/parsers/registry.py
作用：文件格式 -> 解析器 的对照表。支持 md、txt、docx、pdf；增加格式只需新增解析器并登记在这里。
"""

from starit_core.ingest.parsers.base import ParseError, Parser
from starit_core.ingest.parsers.docx import DocxParser
from starit_core.ingest.parsers.markdown import MarkdownParser
from starit_core.ingest.parsers.pdf import PdfParser
from starit_core.ingest.parsers.text import TextParser

_PARSERS: dict[str, Parser] = {
    "md": MarkdownParser(),
    "txt": TextParser(),
    "docx": DocxParser(),
    "pdf": PdfParser(),
}


def parser_for(file_format: str) -> Parser:
    """按格式（可带点，不分大小写）取解析器；不支持的格式抛 ParseError。"""
    try:
        return _PARSERS[file_format.lower().lstrip(".")]
    except KeyError:
        raise ParseError(f"no parser for format {file_format!r}") from None
