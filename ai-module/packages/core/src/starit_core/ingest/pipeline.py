"""Run one ingestion job: parse, clean, chunk, (derive), embed, write.

The stages follow docs/design/05-retrieval-etl-and-evaluation.md. Each stage is recorded on the
job, so a failure shows where it happened. Nothing is written to the chunk tables until the
last stage, which replaces the document's old chunks in one transaction: a failure earlier
leaves the previous version of the document searchable and unchanged.
"""

import asyncio
import logging
import tempfile
from collections.abc import Sequence
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from starit_core.audit import write_audit
from starit_core.config import Settings
from starit_core.documents import add_chunk
from starit_core.embeddings import EmbeddingClient
from starit_core.ingest import queue
from starit_core.ingest.chunker import chunk_document
from starit_core.ingest.clean import clean_document
from starit_core.ingest.errors import IngestError
from starit_core.ingest.models import Chunk, ParsedDocument
from starit_core.ingest.parsers import ParseError, parser_for
from starit_core.storage import ObjectStorage

logger = logging.getLogger("starit.ingest")

# The width of ai.chunk_embeddings.embedding. A different width needs a new migration.
VECTOR_COLUMN_DIMENSIONS = 1536


def embedding_input(title: str, chunk: Chunk) -> str:
    """What is embedded: the document title and section path give the text its context."""
    context = "\n".join(part for part in (title, " > ".join(chunk.heading_path)) if part)
    return f"{context}\n\n{chunk.text}" if context else chunk.text


def vector_literal(vector: Sequence[float]) -> str:
    return "[" + ",".join(repr(float(x)) for x in vector) + "]"


async def process_job(
    engine: AsyncEngine,
    job: queue.Job,
    *,
    storage: ObjectStorage,
    embedder: EmbeddingClient,
    settings: Settings,
) -> bool:
    """Run a claimed job to the end. Returns True on success. Never raises for a job failure."""
    stage = "parse"
    try:
        stage = await _stage(engine, job, "parse")
        document = await _load_document(engine, job)
        parsed = await _parse(document, storage)

        stage = await _stage(engine, job, "chunk")
        parsed = clean_document(parsed)
        chunks = chunk_document(
            parsed,
            doc_code=document["doc_code"],
            target_tokens=settings.chunk_target_tokens,
            max_tokens=settings.chunk_max_tokens,
            overlap_tokens=settings.chunk_overlap_tokens,
        )
        if not chunks:
            raise IngestError("chunk", "no_content", "the document has no text", retryable=False)

        # Summaries, questions and keywords are added later, only if evaluation shows they help.
        stage = await _stage(engine, job, "derive")

        stage = await _stage(engine, job, "embed")
        vectors = await _embed(
            embedder, [embedding_input(document["title"], c) for c in chunks], settings
        )

        stage = await _stage(engine, job, "write")
        await _write(engine, job, document["id"], chunks, vectors, embedder)
    except IngestError as error:
        await _fail(engine, job, error)
        return False
    except Exception as exc:  # anything unexpected is recorded against the stage it happened in
        logger.exception("ingestion job %s failed in stage %s", job.id, stage)
        await _fail(engine, job, IngestError(stage, "internal", f"{type(exc).__name__}: {exc}"))
        return False
    logger.info("ingested %s (%d chunks)", document["doc_code"], len(chunks))
    return True


async def _stage(engine: AsyncEngine, job: queue.Job, stage: str) -> str:
    async with engine.begin() as conn:
        await queue.mark_stage(conn, job.id, stage)
    return stage


async def _load_document(engine: AsyncEngine, job: queue.Job) -> dict[str, str]:
    async with engine.connect() as conn:
        row = (
            (
                await conn.execute(
                    text(
                        "SELECT id, doc_code, title, format, object_key "
                        "FROM ai.documents WHERE id = :d"
                    ),
                    {"d": job.document_id},
                )
            )
            .mappings()
            .first()
        )
    if row is None:
        raise IngestError("parse", "document_missing", "the document was deleted", retryable=False)
    if not row["object_key"]:
        raise IngestError("parse", "no_file", "the document has no stored file", retryable=False)
    return {k: str(v) for k, v in row.items()}


async def _parse(document: dict[str, str], storage: ObjectStorage) -> ParsedDocument:
    try:
        data = await storage.get(document["object_key"])
    except FileNotFoundError as exc:
        raise IngestError("parse", "object_missing", f"stored file not found: {exc}") from exc
    suffix = "." + document["format"]
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / f"document{suffix}"
        path.write_bytes(data)
        try:
            return await asyncio.to_thread(parser_for(document["format"]).parse, path)
        except ParseError as exc:
            raise IngestError("parse", "parse_failed", str(exc), retryable=False) from exc


async def _embed(
    embedder: EmbeddingClient, texts: list[str], settings: Settings
) -> list[list[float]]:
    if embedder.dimensions != VECTOR_COLUMN_DIMENSIONS:
        raise IngestError(
            "embed",
            "unsupported_dimensions",
            f"configured dimensions {embedder.dimensions} do not match the "
            f"{VECTOR_COLUMN_DIMENSIONS}-wide vector column; add a migration to change it",
            retryable=False,
        )
    vectors: list[list[float]] = []
    size = max(1, settings.embedding_batch_size)
    for start in range(0, len(texts), size):
        vectors.extend(await embedder.embed(texts[start : start + size]))
    return vectors


async def _write(
    engine: AsyncEngine,
    job: queue.Job,
    document_id: str,
    chunks: list[Chunk],
    vectors: list[list[float]],
    embedder: EmbeddingClient,
) -> None:
    async with engine.begin() as conn:
        await conn.execute(
            text("DELETE FROM ai.document_chunks WHERE document_id = :d"), {"d": document_id}
        )
        for chunk, vector in zip(chunks, vectors, strict=True):
            chunk_id = await add_chunk(
                conn,
                job.document_id,
                chunk_index=chunk.index,
                chunk_text=chunk.text,
                heading_path=list(chunk.heading_path),
                page=chunk.page,
                identifiers=list(chunk.identifiers),
                token_count=chunk.token_count,
            )
            await conn.execute(
                text(
                    "INSERT INTO ai.chunk_embeddings (chunk_id, model, dimensions, embedding) "
                    "VALUES (:c, :m, :d, CAST(:e AS vector))"
                ),
                {
                    "c": chunk_id,
                    "m": embedder.model,
                    "d": embedder.dimensions,
                    "e": vector_literal(vector),
                },
            )
        await queue.mark_succeeded(conn, job)
        await write_audit(
            conn,
            action="doc.ingest",
            doc_ids=[document_id],
            details={
                "chunks": len(chunks),
                "model": embedder.model,
                "dimensions": embedder.dimensions,
                "attempt": job.attempt,
            },
        )


async def _fail(engine: AsyncEngine, job: queue.Job, error: IngestError) -> None:
    async with engine.begin() as conn:
        retry = await queue.mark_failed(conn, job, error)
    logger.warning(
        "ingestion job %s failed in %s (%s): %s -> %s",
        job.id, error.stage, error.code, error.message, "will retry" if retry else "gave up",
    )  # fmt: skip
