"""Helpers shared by the parsers."""

import re

from starit_core.ingest.models import Block

# The metadata block at the top of every sample document repeats what the manifest already says.
META_KEYS = ("doc_id", "version", "status", "effective_date", "access", "campus_scope")
META_LABELS = ("Document ID", "Version", "Status", "Effective", "Audience", "Campus scope")


def render_table(rows: list[list[str]]) -> str:
    """A table as Markdown text: the same form for every file format."""
    rows = [[" ".join(cell.split()) for cell in row] for row in rows if any(c.strip() for c in row)]
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    lines = ["| " + " | ".join(rows[0]) + " |", "|" + "|".join(["---"] * width) + "|"]
    lines += ["| " + " | ".join(r) + " |" for r in rows[1:]]
    return "\n".join(lines)


def table_block(rows: list[list[str]], page: int | None = None) -> Block | None:
    text = render_table(rows)
    return Block("table", text, page=page) if text else None


def is_metadata_table(rows: list[list[str]]) -> bool:
    return bool(rows) and bool(rows[0]) and rows[0][0].strip() == META_LABELS[0]


_EMPHASIS = re.compile(r"(\*\*|__)(.+?)\1")


def strip_emphasis(text: str) -> str:
    return _EMPHASIS.sub(r"\2", text)
