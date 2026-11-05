"""文件：documents.py
作用：文档相关的 HTTP 接口（设计见 docs/design/03 第 4.2、5 节）。分两类：
  - 管理（仅 RAGETLAdmin）：上传、列表、详情、修改（含权限）、删除、重新入库、入库任务历史；
  - 阅读（任何有权读该文档的人）：/chunks 看引用对应的原文片段，/file 下载/查看原文件。
主要思想：
  - 上传只做“收文件 + 登记 + 排队”，立刻返回 202；解析切块嵌入由 worker 异步完成。
  - 上传时校验：扩展名白名单、文件头与扩展名一致（PDF 以 %PDF- 开头、docx 是 zip）、
    文本必须是 UTF-8 且不含二进制、最大 20 MB、文件名净化。
  - 阅读接口用与检索同一个权限条件；无权读的文档返回 404，与不存在无法区分。
"""

import base64
import hashlib
import logging
import re
from datetime import date, datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, Query, Response, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncEngine
from starit_core import documents as store
from starit_core.audit import write_audit
from starit_core.auth import Identity
from starit_core.documents import NewDocument, find_document, register_document
from starit_core.ingest import queue
from starit_core.permissions import expand_access_level
from starit_core.storage import ObjectStorage

from starit_api.deps import get_engine, get_identity, get_storage, require_roles
from starit_api.errors import ApiError

log = logging.getLogger("starit.api")

router = APIRouter(prefix="/documents", tags=["documents"])
# 管理接口的依赖：只有 RAGETLAdmin 角色能调用
admin = require_roles("RAGETLAdmin")

# 上传文件大小上限 20 MB
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
# 文档所属领域
DOMAINS = ("hr", "finance", "tech-support")
# 格式 -> 响应的媒体类型（同时也是允许上传的格式白名单）
MEDIA_TYPES = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "md": "text/markdown; charset=utf-8",
    "txt": "text/plain; charset=utf-8",
}
# 文档编号、版本号、文件名的合法字符（文件名里其他字符会被替换成下划线）
_CODE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$")
_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$")
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]")


def _plain(value: Any) -> Any:
    """把 UUID、日期转成 JSON 能表示的字符串。"""
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, datetime | date):
        return value.isoformat()
    return value


def _meta(row: dict[str, Any]) -> dict[str, Any]:
    """整理文档元数据给前端：转换类型，且不暴露内部的对象存储键。"""
    return {k: _plain(v) for k, v in row.items() if k != "object_key"}


def _check_file(extension: str, data: bytes) -> None:
    """校验上传的文件：扩展名在白名单内，非空，内容开头与扩展名相符；文本文件还要是 UTF-8
    且无二进制字节。不合格抛 422。
    """
    if extension not in MEDIA_TYPES:
        raise ApiError(422, "validation_error", "Only docx, pdf, md and txt files are accepted")
    if not data:
        raise ApiError(422, "validation_error", "The file is empty")
    if extension == "pdf" and not data.startswith(b"%PDF-"):
        raise ApiError(422, "validation_error", "The file is not a PDF")
    if extension == "docx" and not data.startswith(b"PK\x03\x04"):
        raise ApiError(422, "validation_error", "The file is not a Word document")
    if extension in ("md", "txt"):
        try:
            data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ApiError(422, "validation_error", "The text file is not UTF-8") from exc
        if b"\x00" in data:
            raise ApiError(422, "validation_error", "The text file contains binary data")


def _encode_cursor(offset: int) -> str:
    """分页游标：把偏移量编码成不透明的字符串。"""
    return base64.urlsafe_b64encode(str(offset).encode()).decode()


def _decode_cursor(cursor: str | None) -> int:
    """解码分页游标；没有游标从 0 开始，格式不对或为负抛 422。"""
    if not cursor:
        return 0
    try:
        offset = int(base64.urlsafe_b64decode(cursor.encode()).decode())
    except ValueError as exc:
        raise ApiError(422, "validation_error", "Invalid cursor") from exc
    if offset < 0:
        raise ApiError(422, "validation_error", "Invalid cursor")
    return offset


async def _existing(engine: AsyncEngine, document_id: UUID) -> dict[str, Any]:
    """取文档元数据，不存在抛 404。"""
    async with engine.connect() as conn:
        found = await store.get_document(conn, document_id)
    if found is None:
        raise ApiError(404, "not_found", "Document not found")
    return found


# —— 管理接口（仅 RAGETLAdmin）
# --- management ---------------------------------------------------------------------------


@router.post("", status_code=202)
async def upload(
    file: Annotated[UploadFile, File()],
    doc_code: Annotated[str, Form()],
    title: Annotated[str, Form(min_length=1, max_length=200)],
    domain: Annotated[Literal["hr", "finance", "tech-support"], Form()],
    version: Annotated[str, Form()],
    access_level: Annotated[str, Form()],
    status: Annotated[Literal["active", "superseded", "draft"], Form()] = "active",
    effective_date: Annotated[date | None, Form()] = None,
    allowed_users: Annotated[list[str] | None, Form()] = None,
    campus_scope: Annotated[list[str] | None, Form()] = None,
    min_level: Annotated[int | None, Form(ge=1, le=7)] = None,
    supersedes: Annotated[UUID | None, Form()] = None,
    identity: Identity = Depends(admin),
    engine: AsyncEngine = Depends(get_engine),
    storage: ObjectStorage = Depends(get_storage),
) -> JSONResponse:
    """上传并登记一份文档，排入入库队列，返回 202。

    表单字段：file 文件；doc_code/version 编号与版本；title 标题；domain 领域；
      access_level 谁能读；status 状态；effective_date 生效日；allowed_users 指名用户；
      campus_scope 校区范围；min_level 最低职等；supersedes 它取代的旧版本文档 ID。
    失败：参数不合法或文件不合格 422；同编号同版本已存在 409。
    """
    if not _CODE.match(doc_code) or not _VERSION.match(version):
        raise ApiError(422, "validation_error", "Invalid doc_code or version")
    try:
        expand_access_level(access_level)
    except ValueError as exc:
        raise ApiError(422, "validation_error", f"Unknown access_level {access_level!r}") from exc
    name = _SAFE_NAME.sub("_", (file.filename or "").rsplit("/", 1)[-1]) or "upload"
    extension = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise ApiError(422, "validation_error", "The file is larger than 20 MB")
    _check_file(extension, data)
    digest = hashlib.sha256(data).hexdigest()
    key = f"documents/{doc_code}/{version}/{name}"

    # 同一（编号, 版本）不能重复上传
    async with engine.connect() as probe:
        existing = await find_document(probe, doc_code, version)
    if existing is not None:
        raise ApiError(
            409, "conflict", f"{doc_code} version {version} already exists (id {existing['id']})"
        )
    # 先存原文件；之后数据库登记失败就把文件删掉，不留孤儿文件
    await storage.put(key, data)
    try:
        async with engine.begin() as conn:
            document_id = await register_document(
                conn,
                NewDocument(
                    doc_code=doc_code,
                    title=title.strip(),
                    domain=domain,
                    version=version,
                    format=extension,
                    access_level=access_level,
                    status=status,
                    effective_date=effective_date,
                    allowed_users=allowed_users or [],
                    campus_scope=campus_scope or ["all"],
                    min_level_rank=min_level,
                    object_key=key,
                    content_hash=digest,
                    supersedes_id=supersedes,
                ),
                actor=identity,
            )
            job_id = await queue.enqueue(conn, document_id)
    except Exception:
        await storage.delete(key)
        raise
    async with engine.connect() as conn:
        created = await store.get_document(conn, document_id)
    assert created is not None
    return JSONResponse({"document": _meta(created), "job_id": str(job_id)}, status_code=202)


@router.get("")
async def list_documents(
    domain: Literal["hr", "finance", "tech-support"] | None = None,
    status: Literal["active", "superseded", "draft"] | None = None,
    ingest_status: Literal["queued", "running", "ready", "failed"] | None = None,
    q: str | None = Query(None, max_length=100),
    limit: int = Query(20, ge=1, le=100),
    cursor: str | None = None,
    _: Identity = Depends(admin),
    engine: AsyncEngine = Depends(get_engine),
) -> dict[str, Any]:
    """文档列表（不含内容），可按领域、状态、入库状态、标题/编号关键字过滤，游标分页。"""
    offset = _decode_cursor(cursor)
    async with engine.connect() as conn:
        rows = await store.list_documents(
            conn,
            domain=domain,
            status=status,
            ingest_status=ingest_status,
            q=q,
            limit=limit + 1,
            offset=offset,
        )
    more = len(rows) > limit
    return {
        "items": [_meta(r) for r in rows[:limit]],
        "next_cursor": _encode_cursor(offset + limit) if more else None,
    }


class DocumentPatch(BaseModel):
    """修改文档的字段（都可选）：标题、状态、权限级别、指名用户、校区范围、最低职等。"""

    title: str | None = Field(default=None, min_length=1, max_length=200)
    status: Literal["active", "superseded", "draft"] | None = None
    access_level: str | None = None
    allowed_users: list[str] | None = None
    campus_scope: list[str] | None = Field(default=None, min_length=1)
    min_level: int | None = Field(default=None, ge=1, le=7)


@router.get("/{document_id}")
async def get_document(
    document_id: UUID,
    _: Identity = Depends(admin),
    engine: AsyncEngine = Depends(get_engine),
) -> dict[str, Any]:
    """某文档的元数据。"""
    return _meta(await _existing(engine, document_id))


@router.patch("/{document_id}")
async def patch_document(
    document_id: UUID,
    body: DocumentPatch,
    identity: Identity = Depends(admin),
    engine: AsyncEngine = Depends(get_engine),
) -> dict[str, Any]:
    """修改文档的元数据和权限。文档及其全部文本块在一个事务里一起改，并写审计。
    min_level 显式传 null 表示去掉职等要求（与“没传”区分开）。
    """
    await _existing(engine, document_id)
    try:
        async with engine.begin() as conn:
            await store.update_document(
                conn,
                document_id,
                actor=identity,
                title=body.title,
                status=body.status,
                access_level=body.access_level,
                allowed_users=body.allowed_users,
                campus_scope=body.campus_scope,
                min_level_rank=body.min_level,
                clear_min_level="min_level" in body.model_fields_set and body.min_level is None,
            )
    except ValueError as exc:
        raise ApiError(422, "validation_error", str(exc)) from exc
    except LookupError as exc:
        raise ApiError(404, "not_found", "Document not found") from exc
    return _meta(await _existing(engine, document_id))


@router.delete("/{document_id}", status_code=204)
async def delete_document(
    document_id: UUID,
    identity: Identity = Depends(admin),
    engine: AsyncEngine = Depends(get_engine),
    storage: ObjectStorage = Depends(get_storage),
) -> Response:
    """删除文档（数据库里的块、向量、任务随之级联删除）并尽力删除对象存储里的原文件；
    原文件删不掉只记日志。
    """
    found = await _existing(engine, document_id)
    try:
        async with engine.begin() as conn:
            await store.delete_document(conn, document_id, actor=identity)
    except LookupError as exc:
        raise ApiError(404, "not_found", "Document not found") from exc
    if found.get("object_key"):
        try:
            await storage.delete(str(found["object_key"]))
        except Exception:
            log.exception("the original file of a deleted document could not be removed")
    return Response(status_code=204)


@router.post("/{document_id}/reindex", status_code=202)
async def reindex(
    document_id: UUID,
    identity: Identity = Depends(admin),
    engine: AsyncEngine = Depends(get_engine),
) -> dict[str, Any]:
    """重新排一个入库任务（比如换了嵌入模型），写审计。"""
    await _existing(engine, document_id)
    async with engine.begin() as conn:
        job_id = await queue.enqueue(conn, document_id)
        await write_audit(conn, action="doc.reindex", actor=identity, doc_ids=[str(document_id)])
    return {"job_id": str(job_id)}


@router.get("/{document_id}/jobs")
async def jobs(
    document_id: UUID,
    _: Identity = Depends(admin),
    engine: AsyncEngine = Depends(get_engine),
) -> dict[str, Any]:
    """某文档的入库任务历史：状态、阶段、重试次数、错误。"""
    await _existing(engine, document_id)
    async with engine.connect() as conn:
        rows = await store.list_jobs(conn, document_id)
    return {"items": [{k: _plain(v) for k, v in r.items()} for r in rows]}


# —— 阅读接口（任何有权读该文档的人）
# --- reading (anyone who may read the document) -------------------------------------------


@router.get("/{document_id}/chunks")
async def chunks(
    document_id: UUID,
    around: UUID | None = None,
    window: int = Query(2, ge=0, le=10),
    identity: Identity = Depends(get_identity),
    engine: AsyncEngine = Depends(get_engine),
) -> dict[str, Any]:
    """某文档里当前用户有权读的文本块，网页点开引用时用。
    around 指定某块 ID 时只返回它和前后各 window 块。读不到（不存在或无权）统一 404。
    """
    async with engine.connect() as conn:
        found = await store.readable_chunks(
            conn, identity, document_id, around=around, window=window
        )
        meta = await store.get_document(conn, document_id) if found else None
    if not found or meta is None:  # missing and forbidden look the same
        raise ApiError(404, "not_found", "Document not found")
    return {
        "document": {
            k: _plain(meta[k]) for k in ("id", "doc_code", "title", "version", "status", "format")
        },
        "chunks": [{k: _plain(v) for k, v in c.items()} for c in found],
    }


@router.get("/{document_id}/file")
async def original_file(
    document_id: UUID,
    identity: Identity = Depends(get_identity),
    engine: AsyncEngine = Depends(get_engine),
    storage: ObjectStorage = Depends(get_storage),
) -> Response:
    """下载/查看原文件（inline），仅限有权读该文档的人；其余统一 404。"""
    async with engine.connect() as conn:
        allowed = await store.can_read_document(conn, identity, document_id)
        meta = await store.get_document(conn, document_id) if allowed else None
    if meta is None or not meta.get("object_key"):
        raise ApiError(404, "not_found", "Document not found")
    try:
        data = await storage.get(str(meta["object_key"]))
    except FileNotFoundError as exc:
        raise ApiError(404, "not_found", "Document not found") from exc
    filename = f"{meta['doc_code']}-v{meta['version']}.{meta['format']}"
    return Response(
        data,
        media_type=MEDIA_TYPES[str(meta["format"])],
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )
