"""Parsers turn a file into structural blocks. One parser per file format."""

from starit_core.ingest.parsers.base import ParseError, Parser
from starit_core.ingest.parsers.registry import parser_for

__all__ = ["ParseError", "Parser", "parser_for"]
