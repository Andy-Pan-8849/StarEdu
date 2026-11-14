"""文件：business_knowledge.py
作用：业务模块的课程大纲和课件清单 -> AI 知识库（业务模式）。
流程：业务模块在大纲或课件变化时发一个事件（只带课程 id；Kafka 的 business.events）；
这里收到后回业务模块取内容（内部接口，服务密钥，租户由主机名确定），整理成一份 Markdown，
登记成该租户自己的文档（带 tenant_id，别的租户检索不到）并排入库任务；内容没变就什么都不做。
说明：课件目前只有标题和外链，没有文件，所以入库的是"清单"；真实文件的入库等文档库（B11/B12）。
知识库里这类文档的权限是过渡设置：学生和教职员工都能读（见 B12）。
"""

import hashlib
import logging
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import httpx
from sqlalchemy.ext.asyncio import AsyncEngine

from starit_core.auth import Identity
from starit_core.documents import NewDocument, find_document, register_document, set_content
from starit_core.documents import set_status as set_document_status
from starit_core.ingest import queue
from starit_core.storage import ObjectStorage

log = logging.getLogger("starit.knowledge")

# 这个同步产生的文档：编号里带租户代码，版本固定 current，随内容更新
DOC_VERSION = "current"
HANDLED_TYPES = frozenset({"course.syllabus_changed", "material.changed"})
# 审计里的操作者：系统身份，不是人
SYNC_ACTOR = Identity(
    user_id="system:business-sync",
    username=None,
    name="Business knowledge sync",
    roles=frozenset({"RAGETLAdmin"}),
    campus_id=None,
    level=None,
)


class BusinessContentError(Exception):
    """取内容失败：暂时的（可以重试）或这门课已经不存在。"""

    def __init__(self, message: str, *, gone: bool = False) -> None:
        super().__init__(message)
        self.gone = gone


class BusinessContentClient:
    """向业务模块取课程内容：大纲正文和各班已发布的课件清单。"""

    def __init__(
        self, *, url_template: str, internal_key: str, client: httpx.AsyncClient | None = None
    ) -> None:
        self._template = url_template
        self._key = internal_key
        self._client = client or httpx.AsyncClient(timeout=10.0)

    async def fetch_course(self, tenant_code: str, course_id: str) -> dict[str, Any]:
        url = self._template.replace("{code}", tenant_code).rstrip("/")
        try:
            response = await self._client.get(
                f"{url}/api/internal/kb/courses/{course_id}", headers={"X-Internal-Key": self._key}
            )
        except httpx.HTTPError as exc:
            raise BusinessContentError(f"business module unreachable: {exc}") from exc
        if response.status_code == 404:
            raise BusinessContentError("the course no longer exists", gone=True)
        if response.status_code != 200:
            raise BusinessContentError(f"business module answered {response.status_code}")
        body: dict[str, Any] = response.json()
        return body

    async def aclose(self) -> None:
        await self._client.aclose()


def render_course(content: dict[str, Any]) -> str:
    """整理成一份 Markdown：标题、大纲、各班课件清单。"""
    lines = [f"# {content['code']} {content['name']}", ""]
    lines += ["## Syllabus", "", str(content.get("syllabus") or "").strip() or "(none yet)", ""]
    lines += ["## Course materials", ""]
    any_material = False
    for section in content.get("sections", []):
        items = section.get("materials", [])
        if not items:
            continue
        any_material = True
        lines.append(f"### {section['name']}")
        lines += [f"- {m['title']} ({m['category']}): {m['url']}" for m in items]
        lines.append("")
    if not any_material:
        lines += ["(no published materials yet)", ""]
    return "\n".join(lines)


def is_empty(content: dict[str, Any]) -> bool:
    """既没有大纲也没有课件，或课程已停用：不进检索。"""
    has_materials = any(s.get("materials") for s in content.get("sections", []))
    return not content.get("status", True) or not (
        str(content.get("syllabus") or "").strip() or has_materials
    )


@dataclass(frozen=True)
class SyncResult:
    action: str  # registered / updated / unchanged / ignored
    doc_code: str | None = None


class BusinessKnowledgeSync:
    def __init__(
        self, engine: AsyncEngine, storage: ObjectStorage, client: BusinessContentClient
    ) -> None:
        self._engine = engine
        self._storage = storage
        self._client = client

    async def handle(self, event: dict[str, Any]) -> SyncResult:
        """处理一个事件信封。不相关的事件类型直接忽略；其余同步该课程的知识库文档。"""
        if event.get("type") not in HANDLED_TYPES:
            return SyncResult("ignored")
        tenant_id = str(event["tenantId"])
        tenant_code = str(event.get("tenantCode") or "")
        course_id = str((event.get("payload") or {}).get("courseId") or "")
        if not tenant_code or not course_id:
            raise BusinessContentError("the event has no tenant code or course id", gone=True)
        try:
            content = await self._client.fetch_course(tenant_code, course_id)
        except BusinessContentError as exc:
            if exc.gone:
                return SyncResult("ignored")  # 课程没了：没有要同步的
            raise
        return await self._sync(tenant_id, tenant_code, content)

    async def _sync(self, tenant_id: str, tenant_code: str, content: dict[str, Any]) -> SyncResult:
        doc_code = f"BIZ-COURSE-{tenant_code}-{content['code']}"
        markdown = render_course(content).encode("utf-8")
        digest = hashlib.sha256(markdown).hexdigest()
        key = f"documents/{tenant_id}/{doc_code}/{DOC_VERSION}/content.md"
        status = "draft" if is_empty(content) else "active"
        title = f"{content['code']} {content['name']}: syllabus and materials"
        async with self._engine.begin() as conn:
            existing = await find_document(conn, doc_code, DOC_VERSION)
            if existing is None:
                await self._storage.put(key, markdown)
                document_id = await register_document(
                    conn,
                    NewDocument(
                        doc_code=doc_code,
                        title=title,
                        domain="academics",
                        version=DOC_VERSION,
                        format="md",
                        access_level="students-and-staff",
                        status=status,
                        object_key=key,
                        content_hash=digest,
                        tenant_id=tenant_id,
                    ),
                    actor=SYNC_ACTOR,
                )
                await queue.enqueue(conn, document_id)
                return SyncResult("registered", doc_code)
            if str(existing.get("tenant_id") or "") != tenant_id:
                raise BusinessContentError(f"{doc_code} belongs to another tenant", gone=True)
            document_id = UUID(str(existing["id"]))
            action = "unchanged"
            if existing["status"] != status:
                await set_document_status(conn, document_id, status, actor=SYNC_ACTOR)
                action = "updated"
            if existing["content_hash"] != digest:
                await self._storage.put(key, markdown)
                await set_content(
                    conn, document_id, object_key=key, content_hash=digest, actor=SYNC_ACTOR
                )
                await queue.enqueue(conn, document_id)
                action = "updated"
            return SyncResult(action, doc_code)
