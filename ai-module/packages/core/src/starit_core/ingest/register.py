"""文件：ingest/register.py
作用：按清单(manifest.csv)登记文档并排入库任务。
主要思想：和网页上传走同一条路径：保存原文件 -> 记录文档及其权限 -> 排任务。
可重复运行、只处理变化的部分：新文档登记；状态/权限变了就更新；
  内容哈希变了就替换原文件并重新入库；
没变的什么都不做（上次失败或还在排队的会再排一次）。
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

# 脚本/播种时的“操作者”：一个系统身份，审计里据此区分不是人手操作
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
    """一份文档的登记结果；action 是 registered(新登记) / updated(有变更) / unchanged(无变化)。"""

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
    """读取 documents_dir/manifest.csv，逐份登记或更新文档。

    参数：engine 引擎；storage 对象存储；documents_dir 文档目录；actor 操作者；
      force 为真时全部重新排队（比如换了嵌入模型）。
    返回：每份文档的 Registration。
    """
    # 按（文档编号, 生效日期）排序，保证旧版本先登记，新版本能指向“它取代的上一版”
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
        # 内容哈希：判断原文件有没有变
        digest = hashlib.sha256(data).hexdigest()
        key = f"documents/{row['doc_id']}/{row['version']}/{path.name}"
        campus_scope = [c.strip() for c in row["campus_scope"].split(";") if c.strip()] or ["all"]

        async with engine.begin() as conn:
            # 按（编号, 版本）找已有的文档
            existing = await find_document(conn, row["doc_id"], row["version"])
            # 没有 -> 新登记：存原文件、写文档记录、排入库任务
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
                # 已有 -> 逐项比较：状态、权限、内容，变了才更新
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
