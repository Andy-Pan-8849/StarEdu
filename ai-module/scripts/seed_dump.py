"""Write the knowledge base of the running database to seed/ai-seed.jsonl.gz (make seed-dump).

Only do this from a database that was ingested for real (real embeddings): the file is what
`make seed` restores for everyone else, so they need no OpenAI key.
"""

import asyncio
import subprocess
from pathlib import Path

from starit_core.config import get_settings
from starit_core.db import create_engine
from starit_core.seed_ai import dump_ai, read_dump

TARGET = Path(__file__).resolve().parent.parent / "seed" / "ai-seed.jsonl.gz"


def git_sha() -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True
        )
    except OSError:
        return None
    return out.stdout.strip() or None


async def main() -> None:
    engine = create_engine(get_settings())
    try:
        data = await dump_ai(engine, git_sha=git_sha())
    finally:
        await engine.dispose()
    header, _ = read_dump(data)
    if not header["counts"]["documents"]:
        raise SystemExit("the database has no documents: run `make ingest-samples` first")
    if "fake" in str(header["embedding_models"]):
        raise SystemExit("these vectors are fake; ingest with a real embedding model first")
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_bytes(data)
    print(f"wrote {TARGET} ({len(data)} bytes)")
    print(f"  {header['counts']}, models {header['embedding_models']}")


if __name__ == "__main__":
    asyncio.run(main())
