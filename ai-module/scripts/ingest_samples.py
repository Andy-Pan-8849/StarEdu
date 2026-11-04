"""Register the sample documents and queue them for ingestion (make ingest-samples).

--wait     wait until the queued jobs finish and print the result
--process  also run the worker here, once, instead of relying on the worker container
"""

import argparse
import asyncio
import time
from pathlib import Path

from sqlalchemy import text
from starit_core.config import get_settings
from starit_core.db import create_engine
from starit_core.embeddings import embedding_client
from starit_core.ingest.register import register_from_manifest
from starit_core.ingest.worker import run_worker
from starit_core.llm import chat_client
from starit_core.storage import S3Storage

DOCUMENTS = Path(__file__).resolve().parent.parent / "sample-data" / "documents"


async def main(wait: bool, process: bool, force: bool) -> None:
    settings = get_settings()
    engine = create_engine(settings)
    storage = S3Storage(settings)
    await storage.ensure_bucket()
    results = await register_from_manifest(engine, storage, DOCUMENTS, force=force)
    for action in ("registered", "updated", "unchanged"):
        print(f"{action}: {sum(r.action == action for r in results)}")

    if process:
        await run_worker(
            engine,
            storage,
            embedding_client(settings),
            settings,
            once=True,
            chat=chat_client(settings),
        )
    if wait or process:
        deadline = time.monotonic() + 600
        while time.monotonic() < deadline:
            async with engine.connect() as conn:
                rows = (
                    await conn.execute(
                        text("SELECT ingest_status, count(*) FROM ai.documents GROUP BY 1")
                    )
                ).all()
            counts = {status: n for status, n in rows}
            print(counts)
            if not counts.get("queued") and not counts.get("running"):
                break
            await asyncio.sleep(3)
        async with engine.connect() as conn:
            failed = (
                await conn.execute(
                    text(
                        "SELECT d.doc_code, d.version, j.stage, j.error_code, j.error_message "
                        "FROM ai.documents d JOIN ai.ingestion_jobs j ON j.document_id = d.id "
                        "WHERE d.ingest_status = 'failed'"
                    )
                )
            ).all()
        for row in failed:
            print("FAILED", *row)
    await engine.dispose()


if __name__ == "__main__":
    arguments = argparse.ArgumentParser()
    arguments.add_argument("--wait", action="store_true")
    arguments.add_argument("--process", action="store_true")
    arguments.add_argument("--force", action="store_true")
    parsed = arguments.parse_args()
    asyncio.run(main(parsed.wait, parsed.process, parsed.force))
