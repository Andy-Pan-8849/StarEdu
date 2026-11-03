"""Document registration and permission changes.

A chunk carries a copy of its document's permission, status and version fields, so retrieval
can filter a single table. These functions are the only place those fields change, and they
change the document and all of its chunks in one transaction.
"""

from dataclasses import dataclass, field
from datetime import date
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from starit_core.audit import write_audit
from starit_core.auth import Identity
from starit_core.permissions import expand_access_level

STATUSES = ("active", "superseded", "draft")

# The columns a chunk copies from its document.
_SYNCED = (
    "allowed_roles, allowed_users, campus_scope, min_level_rank, status, effective_date, "
    "doc_code, version"
)


@dataclass(frozen=True)
class NewDocument:
    doc_code: str
    title: str
    domain: str
    version: str
    format: str
    access_level: str
    status: str = "active"
    effective_date: date | None = None
    allowed_users: list[str] = field(default_factory=list)
    campus_scope: list[str] = field(default_factory=lambda: ["all"])
    min_level_rank: int | None = None
    object_key: str | None = None
    content_hash: str | None = None
    supersedes_id: UUID | None = None


async def register_document(conn: AsyncConnection, doc: NewDocument, *, actor: Identity) -> UUID:
    if doc.status not in STATUSES:
        raise ValueError(f"unknown status: {doc.status!r}")
    allowed_roles = expand_access_level(doc.access_level)
    async with conn.begin_nested():
        document_id = (
            await conn.execute(
                text(
                    """
                    INSERT INTO ai.documents
                        (doc_code, title, domain, version, status, effective_date, access_level,
                         allowed_roles, allowed_users, campus_scope, min_level_rank, object_key,
                         format, content_hash, uploaded_by, supersedes_id)
                    VALUES
                        (:doc_code, :title, :domain, :version, :status, :effective_date,
                         :access_level, :allowed_roles, :allowed_users, :campus_scope,
                         :min_level_rank, :object_key, :format, :content_hash, :uploaded_by,
                         :supersedes_id)
                    RETURNING id
                    """
                ),
                {
                    "doc_code": doc.doc_code,
                    "title": doc.title,
                    "domain": doc.domain,
                    "version": doc.version,
                    "status": doc.status,
                    "effective_date": doc.effective_date,
                    "access_level": doc.access_level,
                    "allowed_roles": allowed_roles,
                    "allowed_users": doc.allowed_users,
                    "campus_scope": doc.campus_scope,
                    "min_level_rank": doc.min_level_rank,
                    "object_key": doc.object_key,
                    "format": doc.format,
                    "content_hash": doc.content_hash,
                    "uploaded_by": actor.user_id,
                    "supersedes_id": doc.supersedes_id,
                },
            )
        ).scalar_one()
        await write_audit(
            conn,
            action="doc.upload",
            actor=actor,
            doc_ids=[str(document_id)],
            details={"doc_code": doc.doc_code, "version": doc.version,
                     "access_level": doc.access_level},
        )  # fmt: skip
    return UUID(str(document_id))


async def add_chunk(
    conn: AsyncConnection,
    document_id: UUID,
    *,
    chunk_index: int,
    chunk_text: str,
    heading_path: list[str] | None = None,
    page: int | None = None,
    identifiers: list[str] | None = None,
    token_count: int = 0,
) -> UUID:
    """Insert a chunk and copy the document's permission fields onto it in the same statement."""
    chunk_id = (
        await conn.execute(
            text(
                f"""
                INSERT INTO ai.document_chunks
                    (document_id, chunk_index, text, heading_path, page, identifiers, token_count,
                     {_SYNCED})
                SELECT d.id, :chunk_index, :text, :heading_path, :page, :identifiers, :token_count,
                       d.allowed_roles, d.allowed_users, d.campus_scope, d.min_level_rank,
                       d.status, d.effective_date, d.doc_code, d.version
                FROM ai.documents d WHERE d.id = :document_id
                RETURNING id
                """
            ),
            {
                "document_id": document_id,
                "chunk_index": chunk_index,
                "text": chunk_text,
                "heading_path": heading_path or [],
                "page": page,
                "identifiers": identifiers or [],
                "token_count": token_count,
            },
        )
    ).scalar_one()
    return UUID(str(chunk_id))


async def _sync_chunks(conn: AsyncConnection, document_id: UUID) -> int:
    result = await conn.execute(
        text(
            """
            UPDATE ai.document_chunks c
            SET allowed_roles = d.allowed_roles, allowed_users = d.allowed_users,
                campus_scope = d.campus_scope, min_level_rank = d.min_level_rank,
                status = d.status, effective_date = d.effective_date,
                doc_code = d.doc_code, version = d.version
            FROM ai.documents d
            WHERE d.id = c.document_id AND d.id = :document_id
            """
        ),
        {"document_id": document_id},
    )
    return int(result.rowcount)


async def update_access(
    conn: AsyncConnection,
    document_id: UUID,
    *,
    actor: Identity,
    access_level: str | None = None,
    allowed_users: list[str] | None = None,
    campus_scope: list[str] | None = None,
    min_level_rank: int | None = None,
    clear_min_level: bool = False,
) -> int:
    """Change who may read a document. Returns the number of chunks updated."""
    sets: dict[str, object] = {}
    if access_level is not None:
        sets["access_level"] = access_level
        sets["allowed_roles"] = expand_access_level(access_level)
    if allowed_users is not None:
        sets["allowed_users"] = allowed_users
    if campus_scope is not None:
        sets["campus_scope"] = campus_scope
    if min_level_rank is not None:
        sets["min_level_rank"] = min_level_rank
    elif clear_min_level:
        sets["min_level_rank"] = None
    return await _change_document(conn, document_id, sets, actor, "doc.update_access")


async def set_status(
    conn: AsyncConnection, document_id: UUID, status: str, *, actor: Identity
) -> int:
    if status not in STATUSES:
        raise ValueError(f"unknown status: {status!r}")
    return await _change_document(conn, document_id, {"status": status}, actor, "doc.set_status")


async def _change_document(
    conn: AsyncConnection,
    document_id: UUID,
    sets: dict[str, object],
    actor: Identity,
    action: str,
) -> int:
    if not sets:
        return 0
    # Column names come from the fixed set above, never from callers.
    assignments = ", ".join(f"{name} = :{name}" for name in sets)
    # A savepoint, so the document and its chunks change together or not at all.
    async with conn.begin_nested():
        updated = await conn.execute(
            text(f"UPDATE ai.documents SET {assignments}, updated_at = now() WHERE id = :id"),
            {**sets, "id": document_id},
        )
        if updated.rowcount == 0:
            raise LookupError(f"document {document_id} not found")
        count = await _sync_chunks(conn, document_id)
        await write_audit(
            conn,
            action=action,
            actor=actor,
            doc_ids=[str(document_id)],
            details={"changes": sets, "chunks_updated": count},
        )
    return count


async def delete_document(conn: AsyncConnection, document_id: UUID, *, actor: Identity) -> None:
    async with conn.begin_nested():
        deleted = await conn.execute(
            text("DELETE FROM ai.documents WHERE id = :id"), {"id": document_id}
        )
        if deleted.rowcount == 0:
            raise LookupError(f"document {document_id} not found")
        await write_audit(conn, action="doc.delete", actor=actor, doc_ids=[str(document_id)])


async def find_document(
    conn: AsyncConnection, doc_code: str, version: str
) -> dict[str, object] | None:
    row = (
        (
            await conn.execute(
                text(
                    "SELECT id, content_hash, ingest_status, status, access_level, object_key "
                    "FROM ai.documents WHERE doc_code = :c AND version = :v"
                ),
                {"c": doc_code, "v": version},
            )
        )
        .mappings()
        .first()
    )
    return dict(row) if row else None


async def set_content(
    conn: AsyncConnection,
    document_id: UUID,
    *,
    object_key: str,
    content_hash: str,
    actor: Identity,
) -> None:
    """Record that a document's original file was replaced; the caller queues re-ingestion."""
    async with conn.begin_nested():
        updated = await conn.execute(
            text(
                "UPDATE ai.documents SET object_key = :k, content_hash = :h, updated_at = now() "
                "WHERE id = :id"
            ),
            {"k": object_key, "h": content_hash, "id": document_id},
        )
        if updated.rowcount == 0:
            raise LookupError(f"document {document_id} not found")
        await write_audit(
            conn,
            action="doc.replace_content",
            actor=actor,
            doc_ids=[str(document_id)],
            details={"content_hash": content_hash},
        )
