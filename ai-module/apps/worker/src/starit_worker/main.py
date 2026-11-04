"""Entry point of the ingestion worker (starit-worker, or `--once` to drain the queue and exit)."""

import argparse
import asyncio
import logging
from collections.abc import Sequence

from starit_core.config import get_settings
from starit_core.cost import make_budget
from starit_core.db import create_engine
from starit_core.embeddings import embedding_client
from starit_core.ingest.worker import run_worker
from starit_core.llm import chat_client
from starit_core.logging import configure_logging
from starit_core.storage import S3Storage
from starit_core.telemetry import instrument_engine, setup_telemetry

logger = logging.getLogger("starit.worker")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="starit-worker", description="Document ingestion worker")
    parser.add_argument("--once", action="store_true", help="process the ready jobs, then exit")
    return parser.parse_args(argv)


async def _run(once: bool) -> None:
    settings = get_settings()
    setup_telemetry(settings, "starit-worker")
    engine = create_engine(settings)
    instrument_engine(engine)
    storage = S3Storage(settings)
    await storage.ensure_bucket()
    budget = make_budget(settings)
    embedder = embedding_client(settings, budget)
    logger.info(
        "worker started (embedding %s/%s, %d dimensions)",
        settings.embedding_provider, embedder.model, embedder.dimensions,
    )  # fmt: skip
    try:
        await run_worker(engine, storage, embedder, settings, once=once, chat=chat_client(settings))
    finally:
        await engine.dispose()


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    configure_logging(get_settings().log_level)
    asyncio.run(_run(args.once))


if __name__ == "__main__":
    main()
