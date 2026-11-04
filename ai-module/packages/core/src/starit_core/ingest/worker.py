"""The ingestion worker loop."""

import asyncio
import logging
import os
import socket
from collections.abc import Awaitable, Callable

from sqlalchemy.ext.asyncio import AsyncEngine

from starit_core.config import Settings
from starit_core.embeddings import EmbeddingClient
from starit_core.ingest import queue
from starit_core.ingest.pipeline import process_job
from starit_core.llm import ChatClient
from starit_core.storage import ObjectStorage

logger = logging.getLogger("starit.worker")


def default_worker_id() -> str:
    return f"{socket.gethostname()}:{os.getpid()}"


async def run_worker(
    engine: AsyncEngine,
    storage: ObjectStorage,
    embedder: EmbeddingClient,
    settings: Settings,
    *,
    once: bool = False,
    worker_id: str | None = None,
    chat: ChatClient | None = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> int:
    """Process jobs until stopped, or, with `once`, until no job is ready. Returns jobs handled."""
    worker_id = worker_id or default_worker_id()
    handled = 0
    while True:
        async with engine.begin() as conn:
            revived = await queue.requeue_stale(conn, settings.worker_stale_job_seconds)
            job = await queue.claim_next(conn, worker_id)
        if revived:
            logger.warning("put %d stalled job(s) back in the queue", revived)
        if job is None:
            if once:
                return handled
            await sleep(settings.worker_poll_seconds)
            continue
        logger.info("job %s: document %s, attempt %d", job.id, job.document_id, job.attempt)
        await process_job(
            engine, job, storage=storage, embedder=embedder, settings=settings, chat=chat
        )
        handled += 1
