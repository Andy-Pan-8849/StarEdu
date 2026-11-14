"""文件：测试——业务知识同步与知识库的租户隔离（集成）
测什么：大纲/课件事件 -> 该租户自己的知识库文档（登记、没变不动、变了更新并重新排队、空了转草稿）；
格式不对或处理失败的消息进死信；检索只返回提问者同租户的块（独立模式的提问者只看到无租户的块）；
文档管理接口只看得到自己租户的文档。
"""

import hashlib
import json
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine
from starit_core.auth import BusinessAccess, Identity
from starit_core.business_knowledge import (
    BusinessContentError,
    BusinessKnowledgeSync,
    is_empty,
    render_course,
)
from starit_core.documents import (
    NewDocument,
    add_chunk,
    get_document,
    list_documents,
    register_document,
)
from starit_core.ingest.business_events import handle_message
from starit_core.ingest.register import SYSTEM_ACTOR
from starit_core.permissions import chunk_access_clause, chunks

pytestmark = pytest.mark.integration

TENANT_A = str(uuid.uuid4())
TENANT_B = str(uuid.uuid4())


class MemoryStorage:
    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}

    async def ensure_bucket(self) -> None: ...

    async def put(self, key: str, data: bytes) -> None:
        self.files[key] = data

    async def get(self, key: str) -> bytes:
        return self.files[key]

    async def delete(self, key: str) -> None:
        self.files.pop(key, None)


class FakeContent:
    """业务模块内容接口的替身：按课程 id 返回脚本里的内容。"""

    def __init__(self) -> None:
        self.courses: dict[str, dict[str, Any] | Exception] = {}
        self.calls: list[tuple[str, str]] = []

    async def fetch_course(self, tenant_code: str, course_id: str) -> dict[str, Any]:
        self.calls.append((tenant_code, course_id))
        found = self.courses[course_id]
        if isinstance(found, Exception):
            raise found
        return found


def course(
    syllabus: str = "Week 1: basics", materials: int = 1, status: bool = True
) -> dict[str, Any]:
    return {
        "courseId": "c1",
        "code": "CS101",
        "name": "Intro",
        "credits": 3,
        "status": status,
        "syllabus": syllabus,
        "sections": [
            {
                "id": "s1",
                "name": "CS101-01 · 2026 Fall",
                "term": "2026 Fall",
                "materials": [
                    {"title": f"Slides {i}", "category": "slides", "url": f"https://x.test/{i}"}
                    for i in range(materials)
                ],
            }
        ],
    }


def event(
    kind: str = "course.syllabus_changed",
    tenant: str = TENANT_A,
    code: str | None = "hq",
    course_id: str = "c1",
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "type": kind,
        "version": 1,
        "tenantId": tenant,
        "occurredAt": "2026-11-14T00:00:00Z",
        "key": f"{tenant}:course:{course_id}",
        "payload": {"courseId": course_id},
    }
    if code:
        body["tenantCode"] = code
    return body


@pytest.fixture
def storage() -> MemoryStorage:
    return MemoryStorage()


@pytest.fixture
def content() -> FakeContent:
    fake = FakeContent()
    fake.courses["c1"] = course()
    return fake


@pytest.fixture
def sync(
    engines: tuple[AsyncEngine, AsyncEngine], storage: MemoryStorage, content: FakeContent
) -> BusinessKnowledgeSync:
    return BusinessKnowledgeSync(engines[1], storage, content)  # type: ignore[arg-type]


async def jobs(engine: AsyncEngine) -> int:
    async with engine.connect() as conn:
        return int(
            (await conn.execute(text("SELECT count(*) FROM ai.ingestion_jobs"))).scalar_one()
        )


async def doc(engine: AsyncEngine, code: str = "BIZ-COURSE-hq-CS101") -> dict[str, Any]:
    async with engine.connect() as conn:
        row = (
            (
                await conn.execute(
                    text("SELECT * FROM ai.documents WHERE doc_code = :c"), {"c": code}
                )
            )
            .mappings()
            .one()
        )
    return dict(row)


class TestRendering:
    def test_markdown_has_the_syllabus_and_the_material_list(self) -> None:
        md = render_course(course(materials=2))
        assert md.startswith("# CS101 Intro")
        assert "Week 1: basics" in md and "### CS101-01 · 2026 Fall" in md
        assert "- Slides 1 (slides): https://x.test/1" in md

    def test_a_course_with_nothing_to_say_is_empty(self) -> None:
        assert is_empty(course(syllabus="  ", materials=0))
        assert is_empty(course(status=False))
        assert not is_empty(course(syllabus="", materials=1))
        assert not is_empty(course(syllabus="text", materials=0))


class TestSync:
    async def test_a_new_course_becomes_that_tenants_document_and_is_queued(
        self,
        engines: tuple[AsyncEngine, AsyncEngine],
        sync: BusinessKnowledgeSync,
        storage: MemoryStorage,
        content: FakeContent,
    ) -> None:
        result = await sync.handle(event())
        assert (result.action, result.doc_code) == ("registered", "BIZ-COURSE-hq-CS101")
        row = await doc(engines[0])
        assert row["tenant_id"] == TENANT_A and row["status"] == "active" and row["format"] == "md"
        assert row["access_level"] == "students-and-staff" and row["version"] == "current"
        assert storage.files[row["object_key"]].decode().startswith("# CS101 Intro")
        assert row["object_key"].startswith(f"documents/{TENANT_A}/")
        assert content.calls == [("hq", "c1")]
        assert await jobs(engines[0]) == 1

    async def test_nothing_changed_means_nothing_happens(
        self, engines: tuple[AsyncEngine, AsyncEngine], sync: BusinessKnowledgeSync
    ) -> None:
        await sync.handle(event())
        assert (await sync.handle(event("material.changed"))).action == "unchanged"
        assert await jobs(engines[0]) == 1

    async def test_a_changed_syllabus_replaces_the_content_and_queues_again(
        self,
        engines: tuple[AsyncEngine, AsyncEngine],
        sync: BusinessKnowledgeSync,
        storage: MemoryStorage,
        content: FakeContent,
    ) -> None:
        await sync.handle(event())
        before = (await doc(engines[0]))["content_hash"]
        content.courses["c1"] = course(syllabus="Week 1: basics. Week 2: graphs")
        assert (await sync.handle(event())).action == "updated"
        row = await doc(engines[0])
        assert row["content_hash"] != before
        assert row["content_hash"] == hashlib.sha256(storage.files[row["object_key"]]).hexdigest()
        # 第一个任务还在排队，它会读到最新内容，所以不会再多排一个
        assert await jobs(engines[0]) == 1
        assert row["ingest_status"] == "queued"

    async def test_a_course_that_loses_all_content_leaves_retrieval_and_returns_when_filled(
        self,
        engines: tuple[AsyncEngine, AsyncEngine],
        sync: BusinessKnowledgeSync,
        content: FakeContent,
    ) -> None:
        await sync.handle(event())
        content.courses["c1"] = course(syllabus="", materials=0)
        await sync.handle(event())
        assert (await doc(engines[0]))["status"] == "draft"
        content.courses["c1"] = course(syllabus="back again")
        await sync.handle(event())
        assert (await doc(engines[0]))["status"] == "active"

    async def test_other_event_types_and_vanished_courses_are_ignored(
        self,
        engines: tuple[AsyncEngine, AsyncEngine],
        sync: BusinessKnowledgeSync,
        content: FakeContent,
    ) -> None:
        assert (await sync.handle(event("enrollment.registrar_added"))).action == "ignored"
        content.courses["gone"] = BusinessContentError("the course no longer exists", gone=True)
        assert (await sync.handle(event(course_id="gone"))).action == "ignored"
        assert await jobs(engines[0]) == 0

    async def test_an_event_without_a_tenant_code_is_refused(
        self, sync: BusinessKnowledgeSync
    ) -> None:
        with pytest.raises(BusinessContentError):
            await sync.handle(event(code=None))

    async def test_a_document_code_that_belongs_to_another_tenant_is_not_touched(
        self, engines: tuple[AsyncEngine, AsyncEngine], sync: BusinessKnowledgeSync
    ) -> None:
        await sync.handle(event(tenant=TENANT_A))
        with pytest.raises(BusinessContentError):
            await sync.handle(event(tenant=TENANT_B))  # 同一个租户代码 + 课程，却是另一个租户 id
        assert (await doc(engines[0]))["tenant_id"] == TENANT_A


class TestMessages:
    async def run(self, raw: bytes | None, sync: BusinessKnowledgeSync) -> tuple[str, list[str]]:
        dead: list[str] = []
        outcome = await handle_message(raw, sync, lambda _raw, reason: dead.append(reason), pause=0)
        return outcome, dead

    async def test_a_good_event_is_synced(
        self, engines: tuple[AsyncEngine, AsyncEngine], sync: BusinessKnowledgeSync
    ) -> None:
        outcome, dead = await self.run(json.dumps(event()).encode(), sync)
        assert (outcome, dead) == ("synced", [])
        assert await jobs(engines[0]) == 1

    async def test_irrelevant_events_are_skipped_quietly(self, sync: BusinessKnowledgeSync) -> None:
        assert await self.run(json.dumps(event("final_grade.published")).encode(), sync) == (
            "ignored",
            [],
        )

    @pytest.mark.parametrize("raw", [b"not json", b"{}", b'{"id": "x"}', None])
    async def test_garbage_goes_to_the_dead_letter_topic_without_retries(
        self, raw: bytes | None, sync: BusinessKnowledgeSync, content: FakeContent
    ) -> None:
        outcome, dead = await self.run(raw, sync)
        assert outcome == "dead" and len(dead) == 1
        assert content.calls == []

    async def test_a_failing_event_is_retried_three_times_then_dead_lettered_with_the_reason(
        self, sync: BusinessKnowledgeSync, content: FakeContent
    ) -> None:
        content.courses["c1"] = BusinessContentError("business module unreachable")
        outcome, dead = await self.run(json.dumps(event()).encode(), sync)
        assert outcome == "dead" and dead == ["business module unreachable"]
        assert len(content.calls) == 3


def identity(
    tenant: str | None, *, roles: frozenset[str] = frozenset({"student", "staff"})
) -> Identity:
    business = None
    if tenant:
        business = BusinessAccess(
            tenant_id=tenant,
            tenant_code="x",
            account_id="a",
            person_id=None,
            kind="student",
            permissions=frozenset(),
            scopes_json="{}",
            perm_version=1,
        )
    return Identity(
        user_id="u",
        username=None,
        name=None,
        roles=roles,
        campus_id=None,
        level=None,
        business=business,
    )


async def add(conn: AsyncConnection, code: str, tenant: str | None, body: str) -> uuid.UUID:
    document_id = await register_document(
        conn,
        NewDocument(
            doc_code=code,
            title=code,
            domain="academics",
            version="current",
            format="md",
            access_level="students-and-staff",
            tenant_id=tenant,
        ),
        actor=SYSTEM_ACTOR,
    )
    await add_chunk(conn, document_id, chunk_index=0, chunk_text=body)
    return document_id


class TestTenantIsolation:
    async def test_retrieval_only_returns_the_askers_own_tenants_chunks(
        self, owner_conn: AsyncConnection, make_identity: Callable[..., Identity]
    ) -> None:
        await add(owner_conn, "A-1", TENANT_A, "tenant a syllabus")
        await add(owner_conn, "B-1", TENANT_B, "tenant b syllabus")
        await add(owner_conn, "S-1", None, "standalone sample policy")

        async def visible(who: Identity) -> list[str]:
            rows = await owner_conn.execute(
                select(chunks.c.doc_code).where(chunk_access_clause(who))
            )
            return sorted(r[0] for r in rows)

        assert await visible(identity(TENANT_A)) == ["A-1"]
        assert await visible(identity(TENANT_B)) == ["B-1"]
        assert await visible(make_identity({"student", "staff"})) == [
            "S-1"
        ]  # 独立模式：只有无租户的
        assert await visible(identity("11111111-1111-4111-8111-111111111111")) == []

    async def test_the_tenant_is_part_of_the_condition_for_every_role(
        self, owner_conn: AsyncConnection
    ) -> None:
        await add(owner_conn, "A-2", TENANT_A, "hr only a")
        # 总部职能（hr）也不能越过租户
        who = identity(TENANT_B, roles=frozenset({"hr", "finance", "staff"}))
        rows = await owner_conn.execute(select(chunks.c.doc_code).where(chunk_access_clause(who)))
        assert rows.all() == []

    async def test_document_management_sees_only_the_callers_tenant(
        self, owner_conn: AsyncConnection
    ) -> None:
        a = await add(owner_conn, "A-3", TENANT_A, "x")
        await add(owner_conn, "B-3", TENANT_B, "y")
        assert [d["doc_code"] for d in await list_documents(owner_conn, tenant_id=TENANT_A)] == [
            "A-3"
        ]
        assert [d["doc_code"] for d in await list_documents(owner_conn, tenant_id=TENANT_B)] == [
            "B-3"
        ]
        assert await list_documents(owner_conn) == []  # 独立模式的管理员：没有无租户的文档
        assert await get_document(owner_conn, a, tenant_id=TENANT_A) is not None
        assert await get_document(owner_conn, a, tenant_id=TENANT_B) is None
        assert await get_document(owner_conn, a) is None

    async def test_chunks_carry_the_documents_tenant_and_the_drift_view_is_empty(
        self, owner_conn: AsyncConnection
    ) -> None:
        await add(owner_conn, "A-4", TENANT_A, "x")
        tenants = (
            (await owner_conn.execute(text("SELECT DISTINCT tenant_id FROM ai.document_chunks")))
            .scalars()
            .all()
        )
        assert tenants == [TENANT_A]
        assert (
            await owner_conn.execute(text("SELECT count(*) FROM ai.v_chunk_permission_drift"))
        ).scalar_one() == 0
