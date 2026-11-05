"""文件：ingest/parsers/__init__.py
作用：解析器包。每种文件格式一个解析器，把文件变成结构化的块(Block)。
对外只导出 parser_for(格式) 以及 ParseError、Parser。
"""

from starit_core.ingest.parsers.base import ParseError, Parser
from starit_core.ingest.parsers.registry import parser_for

__all__ = ["ParseError", "Parser", "parser_for"]
