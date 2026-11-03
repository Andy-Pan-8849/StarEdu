"""Register the documents listed in a manifest and queue them for ingestion.

This is the same path an upload will use: store the original file, record the document with its
access rules, queue a job. Running it again changes only what changed.
"""

import csv
import hashlib
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncEngine

from starit_core.auth import Identity
from starit_core.documents import (
    NewDocument,
    find_document,
    register_document,
    set_content,
    set_status,
    update_access,
)
from starit_core.ingest import queue
from starit_core.storage import ObjectStorage

SYSTEM_ACTOR = Identity(
    user_id="system:ingest",
    username=None,
    name="Ingestion script",
    roles=frozenset({"RAGETLAdmin"}),
    campus_id=None,
    level=None,
)


@dataclass(frozen=True)
class Registration:
    doc_code: str
    version: str
    action: str  # "registered", "updated" or "unchanged"
    document_id: UUID


async def register_from_manifest(
    engine: AsyncEngine,
    storage: ObjectStorage,
    documents_dir: Path,
    *,
    actor: Identity = SYSTEM_ACTOR,
    force: bool = False,
) -> list[Registration]:
    """`force` queues every document again, e.g. after the embedding model was changed."""
    rows = sorted(
        csv.DictReader(
            (documents_dir / "manifest.csv").read_text(encoding="utf-8").splitlines(), strict=True
        ),
        key=lambda r: (r["doc_id"], r["effective_date"]),
    )

    results: list[Registration] = []
    previous_version: dict[str, UUID] = {}
    for row in rows:
        path = documents_dir / row["file"]
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        key = f"documents/{row['doc_id']}/{row['version']}/{path.name}"
        campus_scope = [c.strip() for c in row["campus_scope"].split(";") if c.strip()] or ["all"]

        async with engine.begin() as conn:
            existing = await find_document(conn, row["doc_id"], row["version"])
            if existing is None:
                await storage.put(key, data)
                document_id = await register_document(
                    conn,
                    NewDocument(
                        doc_code=row["doc_id"],
                        title=row["title"],
                        domain=row["domain"],
                        version=row["version"],
                        format=row["format"],
                        access_level=row["access"],
                        status=row["status"],
                        effective_date=date.fromisoformat(row["effective_date"]),
                        campus_scope=campus_scope,
                        object_key=key,
                        content_hash=digest,
                        supersedes_id=previous_version.get(row["doc_id"]),
                    ),
                    actor=actor,
                )
                await queue.enqueue(conn, document_id)
                action = "registered"
            else:
                document_id = UUID(str(existing["id"]))
                action = "unchanged"
                if existing["status"] != row["status"]:
                    await set_status(conn, document_id, row["status"], actor=actor)
                    action = "updated"
                if existing["access_level"] != row["access"]:
                    await update_access(conn, document_id, actor=actor, access_level=row["access"])
                    action = "updated"
                if (
                    force
                    or existing["content_hash"] != digest
                    or existing["ingest_status"] in ("failed", "queued")
                ):
                    if existing["content_hash"] != digest:
                        await storage.put(key, data)
                        await set_content(
                            conn, document_id, object_key=key, content_hash=digest, actor=actor
                        )
                        action = "updated"
                    await queue.enqueue(conn, document_id)
        previous_version[row["doc_id"]] = document_id
        results.append(Registration(row["doc_id"], row["version"], action, document_id))
    return results
