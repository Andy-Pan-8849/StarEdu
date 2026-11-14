"""文件：documents.py
作用：文档的登记、权限修改、删除与查询（管理类操作的核心逻辑）。
主要思想：文本块里冗余保存了所属文档的权限、状态、版本字段，这样检索只查一张表就能过滤。
代价是这些字段必须保持同步，所以修改它们的入口只有本文件：
改文档和改它的全部文本块在同一个事务（保存点）里完成，要么都改要么都不改，
并且每次改动都写一条审计记录。
"""

from dataclasses import dataclass, field
from datetime import date
from typing import Any
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncConnection

from starit_core.audit import write_audit
from starit_core.auth import Identity
from starit_core.permissions import chunk_access_clause, chunks, expand_access_level

# 文档状态：现行 / 已被取代 / 草稿
STATUSES = ("active", "superseded", "draft")

# The columns a chunk copies from its document.
# 文本块从文档复制的列（权限、状态、版本相关）
_SYNCED = (
    "allowed_roles, allowed_users, campus_scope, min_level_rank, status, effective_date, "
    "doc_code, version, tenant_id"
)


@dataclass(frozen=True)
class NewDocument:
    """登记新文档所需的信息：编号、标题、领域、版本、格式、权限级别，以及可选的指名用户、校区范围、最低职等等。"""

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
    # 业务模式：文档属于哪个租户；None = 独立模式的文档
    tenant_id: str | None = None


async def register_document(conn: AsyncConnection, doc: NewDocument, *, actor: Identity) -> UUID:
    """登记一份新文档（只写文档记录和审计，文本块由入库流水线之后生成）。

    参数：conn 连接；doc 文档信息；actor 操作者。
    返回：新文档的 ID。状态不合法抛 ValueError。
    """
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
                         format, content_hash, uploaded_by, supersedes_id, tenant_id)
                    VALUES
                        (:doc_code, :title, :domain, :version, :status, :effective_date,
                         :access_level, :allowed_roles, :allowed_users, :campus_scope,
                         :min_level_rank, :object_key, :format, :content_hash, :uploaded_by,
                         :supersedes_id, :tenant_id)
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
                    "tenant_id": doc.tenant_id,
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
    """插入一个文本块，并在同一条语句里把文档的权限字段复制到块上，保证两边起点一致。"""
    chunk_id = (
        await conn.execute(
            text(
                f"""
                INSERT INTO ai.document_chunks
                    (document_id, chunk_index, text, heading_path, page, identifiers, token_count,
                     {_SYNCED})
                SELECT d.id, :chunk_index, :text, :heading_path, :page, :identifiers, :token_count,
                       d.allowed_roles, d.allowed_users, d.campus_scope, d.min_level_rank,
                       d.status, d.effective_date, d.doc_code, d.version, d.tenant_id
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
    """把文档的权限/状态/版本字段同步到它的全部文本块；返回更新了几块。"""
    result = await conn.execute(
        text(
            """
            UPDATE ai.document_chunks c
            SET allowed_roles = d.allowed_roles, allowed_users = d.allowed_users,
                campus_scope = d.campus_scope, min_level_rank = d.min_level_rank,
                status = d.status, effective_date = d.effective_date,
                doc_code = d.doc_code, version = d.version, tenant_id = d.tenant_id
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
    """修改谁能读一份文档，并同步到所有块。返回更新的块数。

    参数：access_level 新的权限级别；allowed_users 指名用户；campus_scope 校区范围；
      min_level_rank 最低职等；clear_min_level=True 表示去掉职等要求。
    """
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
    """修改文档状态（active/superseded/draft）并同步到所有块，返回更新的块数。"""
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
    """所有文档变更的公共路径：更新文档 -> 同步文本块 -> 写审计，放在一个保存点里。

    参数：sets 要改的列和新值（列名只来自本文件固定的集合，绝不来自调用方，避免 SQL 注入）；
      action 审计动作名。
    异常：文档不存在抛 LookupError。
    """
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
    """删除文档（文本块、向量、任务随外键级联删除）并写审计。不存在抛 LookupError。"""
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
    """按（文档编号, 版本）找文档，返回其状态等信息；没有则 None。入库幂等判断用它。"""
    row = (
        (
            await conn.execute(
                text(
                    "SELECT id, content_hash, ingest_status, status, access_level, object_key, "
                    "tenant_id FROM ai.documents WHERE doc_code = :c AND version = :v"
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
    """记录文档的原始文件被替换了（新的对象键和内容哈希）；调用方随后要排队重新入库。"""
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


# --- reading and managing documents through the API -------------------------------------------

# —— 以下是通过 API 读取和管理文档的函数。列表里不含正文
_LISTED = (
    "id, doc_code, title, domain, version, status, effective_date, access_level, allowed_users, "
    "campus_scope, min_level_rank, format, ingest_status, content_hash, uploaded_by, "
    "supersedes_id, created_at, updated_at, tenant_id"
)


async def list_documents(
    conn: AsyncConnection,
    *,
    domain: str | None = None,
    status: str | None = None,
    ingest_status: str | None = None,
    q: str | None = None,
    limit: int = 20,
    offset: int = 0,
    tenant_id: str | None = None,
) -> list[dict[str, Any]]:
    """文档元数据列表（不含内容），最新的在前。

    参数：domain/status/ingest_status 过滤；q 按标题或编号模糊搜；limit/offset 分页。
    说明：调用方传 limit+1 来判断是否还有下一页。
    """
    pattern = None
    if q:
        # 转义 LIKE 的通配符，让用户输入的 % 和 _ 按字面匹配
        escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
    rows = await conn.execute(
        text(
            f"SELECT {_LISTED} FROM ai.documents "
            "WHERE (CAST(:domain AS text) IS NULL OR domain = :domain) "
            "AND (CAST(:status AS text) IS NULL OR status = :status) "
            "AND (CAST(:ingest AS text) IS NULL OR ingest_status = :ingest) "
            "AND (CAST(:q AS text) IS NULL OR title ILIKE :q OR doc_code ILIKE :q) "
            "AND tenant_id IS NOT DISTINCT FROM CAST(:tenant AS text) "
            "ORDER BY created_at DESC, id LIMIT :limit OFFSET :offset"
        ),
        {
            "domain": domain,
            "status": status,
            "ingest": ingest_status,
            "q": pattern,
            "tenant": tenant_id,
            "limit": limit,
            "offset": offset,
        },
    )
    return [dict(r) for r in rows.mappings()]


async def get_document(
    conn: AsyncConnection, document_id: UUID, *, tenant_id: str | None = None
) -> dict[str, Any] | None:
    """取单个文档的元数据（含对象键）；没有则 None。只取调用者租户的文档（独立模式 = 无租户的）。"""
    row = (
        (
            await conn.execute(
                text(
                    f"SELECT {_LISTED}, object_key FROM ai.documents WHERE id = :id "
                    "AND tenant_id IS NOT DISTINCT FROM CAST(:tenant AS text)"
                ),
                {"id": document_id, "tenant": tenant_id},
            )
        )
        .mappings()
        .first()
    )
    return dict(row) if row else None


async def list_jobs(conn: AsyncConnection, document_id: UUID) -> list[dict[str, Any]]:
    """某文档的入库任务历史，最近的在前（状态、阶段、重试次数、错误）。"""
    rows = await conn.execute(
        text(
            "SELECT id, status, stage, attempt, max_attempts, error_code, error_message, "
            "started_at, finished_at FROM ai.ingestion_jobs WHERE document_id = :d "
            "ORDER BY coalesce(started_at, run_after) DESC, id"
        ),
        {"d": document_id},
    )
    return [dict(r) for r in rows.mappings()]


async def update_document(
    conn: AsyncConnection,
    document_id: UUID,
    *,
    actor: Identity,
    title: str | None = None,
    status: str | None = None,
    access_level: str | None = None,
    allowed_users: list[str] | None = None,
    campus_scope: list[str] | None = None,
    min_level_rank: int | None = None,
    clear_min_level: bool = False,
) -> int:
    """一次修改标题、状态和权限：文档和所有文本块一起变；返回更新的块数。"""
    sets: dict[str, object] = {}
    if title is not None:
        sets["title"] = title
    if status is not None:
        if status not in STATUSES:
            raise ValueError(f"unknown status: {status!r}")
        sets["status"] = status
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
    return await _change_document(conn, document_id, sets, actor, "doc.update")


async def readable_chunks(
    conn: AsyncConnection,
    identity: Identity,
    document_id: UUID,
    *,
    around: UUID | None = None,
    window: int = 2,
    limit: int = 50,
) -> list[dict[str, Any]] | None:
    """某文档里该用户有权读的文本块，用于点开引用看原文。

    参数：around 指定某块 ID 时只返回它和前后各 window 块；limit 无 around 时的最多块数。
    返回：块列表；一块也读不到则返回 None——无权读的文档看起来与不存在的完全一样。
    """
    statement = (
        select(
            chunks.c.id,
            chunks.c.chunk_index,
            chunks.c.text,
            chunks.c.heading_path,
            chunks.c.page,
        )
        .where(chunks.c.document_id == document_id, chunk_access_clause(identity))
        .order_by(chunks.c.chunk_index)
    )
    rows = [dict(r) for r in (await conn.execute(statement)).mappings()]
    if not rows:
        return None
    if around is not None:
        position = next((i for i, r in enumerate(rows) if r["id"] == around), None)
        if position is not None:
            return rows[max(0, position - window) : position + window + 1]
    return rows[:limit]


async def can_read_document(conn: AsyncConnection, identity: Identity, document_id: UUID) -> bool:
    """该用户是否至少能读这份文档的一块（用与检索同一个权限条件）。"""
    found = await conn.execute(
        select(chunks.c.id)
        .where(chunks.c.document_id == document_id, chunk_access_clause(identity))
        .limit(1)
    )
    return found.first() is not None
