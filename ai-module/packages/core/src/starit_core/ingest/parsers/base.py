from pathlib import Path
from typing import Protocol

from starit_core.ingest.models import ParsedDocument


class ParseError(Exception):
    """The file could not be read as the format it claims to be."""


class Parser(Protocol):
    def parse(self, path: Path) -> ParsedDocument: ...
