"""Everything a fresh stack needs to be usable (make seed).

1. the sample business tables (biz schema, read through the ai_sql views);
2. the knowledge base: restored from seed/ai-seed.jsonl.gz, which needs no model key, or, with
   --ingest, built by the real ingestion pipeline (that one needs the embedding key);
3. the original files of the sample documents in object storage, so a citation can be opened.

The Keycloak realm with its demo accounts is imported when the stack starts.
"""

import argparse
import asyncio
import sys
from pathlib import Path

from sqlalchemy import create_engine as create_sync_engine
from sqlalchemy import text
from starit_core.config import get_settings
from starit_core.db import create_engine
from starit_core.embeddings import embedding_client
from starit_core.ingest.register import register_from_manifest
from starit_core.ingest.worker import run_worker
from starit_core.llm import chat_client
from starit_core.seed_ai import load_ai, read_dump, upload_originals
from starit_core.seed_biz import load_biz
from starit_core.storage import S3Storage

ROOT = Path(__file__).resolve().parent.parent
DUMP = ROOT / "seed" / "ai-seed.jsonl.gz"
DOCUMENTS = ROOT / "sample-data" / "documents"


async def main(ingest: bool) -> None:
    settings = get_settings()

    owner = create_sync_engine(settings.migration_database_url)
    with owner.begin() as conn:
        counts = load_biz(conn, ROOT / "sample-data" / "structured")
    owner.dispose()
    print("business tables:", ", ".join(f"{t}={n}" for t, n in counts.items()))

    storage = S3Storage(settings)
    await storage.ensure_bucket()
    engine = create_engine(settings)
    try:
        if ingest:
            await register_from_manifest(engine, storage, DOCUMENTS, force=True)
            await run_worker(
                engine, storage, embedding_client(settings), settings, once=True,
                chat=chat_client(settings),
            )  # fmt: skip
            print("knowledge base: ingested with the real pipeline")
        else:
            if not DUMP.exists():
                raise SystemExit(f"{DUMP} is missing; run `make seed ARGS=--ingest` instead")
            data = DUMP.read_bytes()
            header, _ = read_dump(data)
            if header["embedding_models"] != settings.embedding_model:
                print(
                    f"warning: the dump has {header['embedding_models']} vectors but the "
                    f"configured model is {settings.embedding_model}; search only compares "
                    "vectors of the same model",
                    file=sys.stderr,
                )
            restored = await load_ai(engine, data)
            print("knowledge base: restored from the dump:", restored)
            print("original files:", await upload_originals(storage, DOCUMENTS))
        async with engine.connect() as conn:
            ready = (
                await conn.execute(
                    text("SELECT count(*) FROM ai.documents WHERE ingest_status = 'ready'")
                )
            ).scalar_one()
        print(f"{ready} document(s) ready")
    finally:
        await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--ingest", action="store_true", help="build with the real pipeline")
    asyncio.run(main(parser.parse_args().ingest))
