"""文件：ingest/pipeline.py
作用：执行一个入库任务：解析 -> 清洗/切块 -> (衍生内容) -> 嵌入 -> 写库。
各阶段见 docs/design/05。
主要思想：
  - 每进入一个阶段就记在任务上，失败时能看出卡在哪一步。
  - 直到最后一个阶段才动 chunk 相关的表，并且在一个事务里“删旧块、写新块”：
    前面任何一步失败，文档原来的版本仍然可检索、完全没变。
  - process_job 永不向外抛异常，所有失败都记到任务上并决定是否重试。
"""

import asyncio
import logging
import tempfile
from collections.abc import Sequence
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from starit_core import telemetry
from starit_core.audit import write_audit
from starit_core.config import Settings
from starit_core.documents import add_chunk
from starit_core.embeddings import EmbeddingClient, vector_literal
from starit_core.ingest import queue
from starit_core.ingest.chunker import chunk_document
from starit_core.ingest.clean import clean_document
from starit_core.ingest.derive import Derived, derive_chunks
from starit_core.ingest.errors import IngestError
from starit_core.ingest.models import Chunk, ParsedDocument
from starit_core.ingest.parsers import ParseError, parser_for
from starit_core.llm import ChatClient
from starit_core.storage import ObjectStorage

logger = logging.getLogger("starit.ingest")

# The width of ai.chunk_embeddings.embedding. A different width needs a new migration.
# 数据库向量列的宽度；换宽度需要新的迁移
VECTOR_COLUMN_DIMENSIONS = 1536


def embedding_input(title: str, chunk: Chunk, derived: Sequence[Derived] = ()) -> str:
    """决定“被嵌入的文字”是什么：文档标题和章节路径提供上下文，再加正文；
    若要了衍生内容，附在正文之后（绝不取代正文）。
    """
    context = "\n".join(part for part in (title, " > ".join(chunk.heading_path)) if part)
    body = f"{context}\n\n{chunk.text}" if context else chunk.text
    extra = "\n".join(d.text for d in derived)
    return f"{body}\n\n{extra}" if extra else body


async def process_job(
    engine: AsyncEngine,
    job: queue.Job,
    *,
    storage: ObjectStorage,
    embedder: EmbeddingClient,
    settings: Settings,
    chat: ChatClient | None = None,
) -> bool:
    """把一个已领取的任务跑到结束，成功返回 True。任务失败不会抛异常（记入任务）；
    同时记录链路和指标。
    """
    with telemetry.span("ingest.job", {"job_id": str(job.id), "attempt": job.attempt}) as active:
        ok = await _process_job(
            engine, job, storage=storage, embedder=embedder, settings=settings, chat=chat
        )
        active.set_attribute("ingest.succeeded", ok)
        if not ok:
            telemetry.fail(active, "ingestion failed")
    telemetry.current().ingest_jobs.add(1, {"status": "succeeded" if ok else "failed"})
    return ok


async def _process_job(
    engine: AsyncEngine,
    job: queue.Job,
    *,
    storage: ObjectStorage,
    embedder: EmbeddingClient,
    settings: Settings,
    chat: ChatClient | None,
) -> bool:
    """入库的主流程，按阶段推进：
      parse 读原文件并解析 -> chunk 清洗并切块 -> derive 衍生内容 -> embed 批量嵌入 -> write
        写库。
    IngestError 按其 retryable 决定是否重试；其他异常归到当前阶段，标为 internal。
    """
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

        stage = await _stage(engine, job, "derive")
        mode = str(job.config.get("derive", settings.ingest_derive))
        if mode != "none" and chat is None:
            raise IngestError(
                "derive", "no_model", "derived content was asked for but no model is configured",
                retryable=False,
            )  # fmt: skip
        derived = (
            await derive_chunks(chat, settings.model_derive, document["title"], chunks, mode)
            if chat is not None and mode != "none"
            else [[] for _ in chunks]
        )

        stage = await _stage(engine, job, "embed")
        vectors = await _embed(
            embedder,
            [
                embedding_input(document["title"], c, d)
                for c, d in zip(chunks, derived, strict=True)
            ],
            settings,
        )

        stage = await _stage(engine, job, "write")
        await _write(engine, job, document["id"], chunks, vectors, embedder, derived, mode)
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
    """把任务当前阶段记入数据库（独立事务，立即可见），并返回阶段名。"""
    async with engine.begin() as conn:
        await queue.mark_stage(conn, job.id, stage)
    return stage


async def _load_document(engine: AsyncEngine, job: queue.Job) -> dict[str, str]:
    """读取文档记录；文档已被删除或没有原文件时抛不可重试的 IngestError。"""
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
    """从对象存储取原文件，写入临时目录，用对应格式的解析器解析（在线程里跑，避免阻塞）。"""
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
    """分批嵌入所有文字（每批 embedding_batch_size 条）。
    嵌入模型的维度与数据库列不一致时直接失败且不重试。
    """
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
    derived: list[list[Derived]],
    derive_mode: str,
) -> None:
    """最后一个阶段，在一个事务里完成：删除文档原有的块 -> 逐块写入文本块、向量、衍生内容 ->
    标记任务成功 -> 写审计。任何一步失败整体回滚，旧块保持不变。
    """
    async with engine.begin() as conn:
        await conn.execute(
            # 先删旧块（向量、衍生内容随外键级联删除），再写新块
            text("DELETE FROM ai.document_chunks WHERE document_id = :d"),
            {"d": document_id},
        )
        for chunk, vector, items in zip(chunks, vectors, derived, strict=True):
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
            for item in items:
                await conn.execute(
                    text("INSERT INTO ai.chunk_derived (chunk_id, kind, text) VALUES (:c, :k, :t)"),
                    {"c": chunk_id, "k": item.kind, "t": item.text},
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
                "derive": derive_mode,
            },
        )


async def _fail(engine: AsyncEngine, job: queue.Job, error: IngestError) -> None:
    """记录失败：交给队列决定重试还是放弃，并写日志。"""
    async with engine.begin() as conn:
        retry = await queue.mark_failed(conn, job, error)
    logger.warning(
        "ingestion job %s failed in %s (%s): %s -> %s",
        job.id, error.stage, error.code, error.message, "will retry" if retry else "gave up",
    )  # fmt: skip
