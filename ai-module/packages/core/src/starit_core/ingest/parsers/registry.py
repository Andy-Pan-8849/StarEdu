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
    try:
        return _PARSERS[file_format.lower().lstrip(".")]
    except KeyError:
        raise ParseError(f"no parser for format {file_format!r}") from None
