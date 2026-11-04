"""Save and restore the knowledge base (documents, chunks, vectors, derived content).

The dump is what a real ingestion produced, written as gzip-compressed JSON lines: a header, then
one line per row. Restoring it gives a working knowledge base without a model key, which is what
`make seed` does. Conversations, audit records and evaluation results are not part of it.

Rows are written and read through `row_to_json` and `jsonb_populate_recordset`, so every column
type (arrays, dates, the pgvector column) goes through Postgres' own text forms, and a column added
by a later migration is picked up without changing this file. Generated columns (the full-text
vector) are left out and recomputed by the database.
"""

import csv
import gzip
import io
import json
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

FORMAT = 1
TABLES = ("documents", "document_chunks", "chunk_embeddings", "chunk_derived")
BATCH = 100


class SeedError(Exception):
    """The dump cannot be restored as it is."""


async def _columns(conn: AsyncConnection, table: str) -> list[str]:
    rows = await conn.execute(
        text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = 'ai' AND table_name = :t AND is_generated = 'NEVER' "
            "ORDER BY ordinal_position"
        ),
        {"t": table},
    )
    columns = [str(r[0]) for r in rows]
    if not columns:
        raise SeedError(f"table ai.{table} is not readable")
    return columns


async def dump_ai(engine: AsyncEngine, *, git_sha: str | None = None) -> bytes:
    lines: list[str] = []
    async with engine.connect() as conn:
        counts: dict[str, int] = {}
        body: list[str] = []
        for table in TABLES:
            columns = await _columns(conn, table)
            selected = ", ".join(columns)
            rows = await conn.execute(
                text(
                    f"SELECT row_to_json(t)::text FROM (SELECT {selected} FROM ai.{table} "
                    "ORDER BY 1) t"
                )
            )
            found = [str(r[0]) for r in rows]
            counts[table] = len(found)
            body += [f'{{"t":"{table}","r":{row}}}' for row in found]
        model = (
            await conn.execute(
                text("SELECT string_agg(DISTINCT model, ',') FROM ai.chunk_embeddings")
            )
        ).scalar()
    header = {
        "format": FORMAT,
        "created": datetime.now(UTC).isoformat(timespec="seconds"),
        "git_sha": git_sha,
        "embedding_models": model,
        "counts": counts,
    }
    lines.append(json.dumps(header))
    lines += body
    buffer = io.BytesIO()
    # mtime=0 so the same content always gives the same bytes.
    with gzip.GzipFile(fileobj=buffer, mode="wb", mtime=0) as out:
        out.write(("\n".join(lines) + "\n").encode())
    return buffer.getvalue()


def read_dump(data: bytes) -> tuple[dict[str, Any], Iterator[tuple[str, dict[str, Any]]]]:
    raw = gzip.decompress(data).decode().splitlines()
    if not raw:
        raise SeedError("the dump is empty")
    header = json.loads(raw[0])
    if header.get("format") != FORMAT:
        raise SeedError(f"unknown dump format {header.get('format')!r}")

    def rows() -> Iterator[tuple[str, dict[str, Any]]]:
        for line in raw[1:]:
            item = json.loads(line)
            yield item["t"], item["r"]

    return header, rows()


async def load_ai(engine: AsyncEngine, data: bytes, *, replace: bool = True) -> dict[str, int]:
    """Restore the dump in one transaction. With `replace` the existing documents (and with them
    their chunks, vectors and jobs) are removed first; without it the tables must not clash."""
    header, rows = read_dump(data)
    per_table: dict[str, list[dict[str, Any]]] = {t: [] for t in TABLES}
    for table, row in rows:
        if table not in per_table:
            raise SeedError(f"the dump has an unknown table {table!r}")
        per_table[table].append(row)
    for table in TABLES:
        if len(per_table[table]) != header["counts"].get(table):
            raise SeedError(f"the dump is incomplete: ai.{table}")

    async with engine.begin() as conn:
        if replace:
            await conn.execute(text("DELETE FROM ai.documents"))
        for table in TABLES:  # parents before children
            columns = ", ".join(await _columns(conn, table))
            statement = text(
                f"INSERT INTO ai.{table} ({columns}) SELECT {columns} "
                f"FROM jsonb_populate_recordset(NULL::ai.{table}, CAST(:rows AS jsonb))"
            )
            rows_of = per_table[table]
            for start in range(0, len(rows_of), BATCH):
                await conn.execute(statement, {"rows": json.dumps(rows_of[start : start + BATCH])})
        drift = (
            await conn.execute(text("SELECT count(*) FROM ai.v_chunk_permission_drift"))
        ).scalar_one()
        if drift:
            raise SeedError(f"{drift} restored chunk(s) disagree with their document's permissions")
        counts = {
            table: int((await conn.execute(text(f"SELECT count(*) FROM ai.{table}"))).scalar_one())
            for table in TABLES
        }
    return counts


async def upload_originals(storage: Any, documents_dir: Path) -> int:
    """Put each sample file in object storage under the key ingestion gives it
    (documents/<code>/<version>/<file>), so a restored document's original can be opened."""
    count = 0
    manifest = (documents_dir / "manifest.csv").read_text(encoding="utf-8").splitlines()
    for row in csv.DictReader(manifest):
        path = documents_dir / row["file"]
        await storage.put(
            f"documents/{row['doc_id']}/{row['version']}/{path.name}", path.read_bytes()
        )
        count += 1
    return count
