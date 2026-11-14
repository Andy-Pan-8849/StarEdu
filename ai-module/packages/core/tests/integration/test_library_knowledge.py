"""文件：测试——文档库文件 -> 知识库，以及按文件夹授权的检索权限（B12，集成）
测什么：library.file_changed 事件 -> 该租户的知识库文档（登记、移动换文件夹、内容变了重新排队、删除/不支持的格式
转草稿）；检索条件：来自文档库的块只看"能读的文件夹列表"，角色/校区/职等不再起作用；列表为空什么都读不到；
别的租户的块永远读不到；课程大纲这类没有文件夹的块仍走原规则；漂移检查视图保持为空。
"""

import hashlib
import uuid
from typing import Any

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine
from starit_core.auth import BusinessAccess, Identity
from starit_core.business_knowledge import BusinessContentError, BusinessKnowledgeSync
from starit_core.documents import NewDocument, add_chunk, register_document
from starit_core.ingest.register import SYSTEM_ACTOR
from starit_core.permissions import chunk_access_clause, chunks

pytestmark = pytest.mark.integration

TENANT_A = str(uuid.uuid4())
TENANT_B = str(uuid.uuid4())
F_PUBLIC, F_HR, F_SEALED = (str(uuid.uuid4()) for _ in range(3))


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


class FakeFiles:
    """业务模块文件接口的替身。"""

    def __init__(self) -> None:
        self.meta: dict[str, dict[str, Any]] = {}
        self.data: dict[str, bytes] = {}
        self.calls: list[str] = []

    def put(self, file_id: str, name: str, body: bytes, folder: str, **over: Any) -> None:
        self.meta[file_id] = {
            "fileId": file_id,
            "folderId": folder,
            "name": name,
            "contentType": "text/plain",
            "size": len(body),
            "version": 1,
            "deleted": False,
            "classification": "internal",
            **over,
        }
        self.data[file_id] = body

    async def fetch_file(self, tenant_code: str, file_id: str) -> dict[str, Any]:
        self.calls.append(f"meta:{tenant_code}:{file_id}")
        if file_id not in self.meta:
            raise BusinessContentError("the file no longer exists", gone=True)
        return self.meta[file_id]

    async def fetch_file_content(self, tenant_code: str, file_id: str) -> bytes:
        self.calls.append(f"content:{tenant_code}:{file_id}")
        return self.data[file_id]


def event(file_id: str, tenant: str = TENANT_A, code: str = "hq") -> dict[str, Any]:
    return {
        "id": str(uuid.uuid4()),
        "type": "library.file_changed",
        "version": 1,
        "tenantId": tenant,
        "tenantCode": code,
        "occurredAt": "2026-11-14T00:00:00Z",
        "key": f"{tenant}:file:{file_id}",
        "payload": {"fileId": file_id},
    }


@pytest.fixture
def storage() -> MemoryStorage:
    return MemoryStorage()


@pytest.fixture
def files() -> FakeFiles:
    return FakeFiles()


@pytest.fixture
def sync(
    engines: tuple[AsyncEngine, AsyncEngine], storage: MemoryStorage, files: FakeFiles
) -> BusinessKnowledgeSync:
    return BusinessKnowledgeSync(engines[1], storage, files)  # type: ignore[arg-type]


async def doc(engine: AsyncEngine, file_id: str, tenant_code: str = "hq") -> dict[str, Any]:
    async with engine.connect() as conn:
        row = (
            (
                await conn.execute(
                    text("SELECT * FROM ai.documents WHERE doc_code = :c"),
                    {"c": f"BIZ-FILE-{tenant_code}-{file_id}"},
                )
            )
            .mappings()
            .one()
        )
    return dict(row)


async def jobs(engine: AsyncEngine) -> int:
    async with engine.connect() as conn:
        return int(
            (await conn.execute(text("SELECT count(*) FROM ai.ingestion_jobs"))).scalar_one()
        )


class TestFileSync:
    async def test_a_new_file_becomes_a_folder_document_with_no_roles(
        self,
        engines: tuple[AsyncEngine, AsyncEngine],
        sync: BusinessKnowledgeSync,
        files: FakeFiles,
        storage: MemoryStorage,
    ) -> None:
        files.put(
            "f1", "leave-policy.md", b"# Leave\n5 days a year", F_HR, classification="internal"
        )
        result = await sync.handle(event("f1"))
        assert (result.action, result.doc_code) == ("registered", "BIZ-FILE-hq-f1")
        row = await doc(engines[0], "f1")
        assert row["tenant_id"] == TENANT_A and row["folder_id"] == F_HR
        assert row["classification"] == "internal" and row["format"] == "md"
        assert row["allowed_roles"] == [] and row["access_level"] == "folder"
        assert row["title"] == "leave-policy.md" and row["domain"] == "library"
        assert storage.files[row["object_key"]] == b"# Leave\n5 days a year"
        assert await jobs(engines[0]) == 1

    async def test_nothing_changed_means_nothing_happens(
        self,
        engines: tuple[AsyncEngine, AsyncEngine],
        sync: BusinessKnowledgeSync,
        files: FakeFiles,
    ) -> None:
        files.put("f1", "a.txt", b"hello", F_HR)
        await sync.handle(event("f1"))
        assert (await sync.handle(event("f1"))).action == "unchanged"
        assert await jobs(engines[0]) == 1

    async def test_moving_the_file_changes_the_folder_of_the_document_and_all_its_chunks(
        self,
        engines: tuple[AsyncEngine, AsyncEngine],
        sync: BusinessKnowledgeSync,
        files: FakeFiles,
    ) -> None:
        files.put("f1", "a.txt", b"hello", F_HR)
        await sync.handle(event("f1"))
        document_id = (await doc(engines[0], "f1"))["id"]
        async with engines[1].begin() as conn:
            await add_chunk(conn, document_id, chunk_index=0, chunk_text="hello")
        files.meta["f1"]["folderId"] = F_SEALED
        files.meta["f1"]["classification"] = "confidential"
        assert (await sync.handle(event("f1"))).action == "updated"
        row = await doc(engines[0], "f1")
        assert row["folder_id"] == F_SEALED and row["classification"] == "confidential"
        async with engines[0].connect() as conn:
            folders = (
                (await conn.execute(text("SELECT DISTINCT folder_id FROM ai.document_chunks")))
                .scalars()
                .all()
            )
            drift = (
                await conn.execute(text("SELECT count(*) FROM ai.v_chunk_permission_drift"))
            ).scalar_one()
        assert folders == [F_SEALED] and drift == 0

    async def test_a_new_version_replaces_the_content_and_a_rename_the_title_and_format(
        self,
        engines: tuple[AsyncEngine, AsyncEngine],
        sync: BusinessKnowledgeSync,
        files: FakeFiles,
        storage: MemoryStorage,
    ) -> None:
        files.put("f1", "a.txt", b"v1", F_HR)
        await sync.handle(event("f1"))
        files.put("f1", "a.md", b"# v2", F_HR, version=2)
        assert (await sync.handle(event("f1"))).action == "updated"
        row = await doc(engines[0], "f1")
        assert row["title"] == "a.md" and row["format"] == "md"
        assert row["content_hash"] == hashlib.sha256(b"# v2").hexdigest()
        assert storage.files[row["object_key"]] == b"# v2"

    async def test_a_deleted_file_or_an_unsupported_format_leaves_retrieval(
        self,
        engines: tuple[AsyncEngine, AsyncEngine],
        sync: BusinessKnowledgeSync,
        files: FakeFiles,
    ) -> None:
        files.put("f1", "a.txt", b"x", F_HR)
        files.put("f2", "sheet.xlsx", b"x", F_HR)
        await sync.handle(event("f1"))
        files.meta["f1"]["deleted"] = True
        assert (await sync.handle(event("f1"))).action == "updated"
        assert (await doc(engines[0], "f1"))["status"] == "draft"
        assert (await sync.handle(event("f1"))).action == "unchanged"
        assert (await sync.handle(event("f2"))).action == "ignored"  # 不支持的格式：没有登记
        del files.meta["f1"]  # 彻底没了：文档保持草稿
        assert (await sync.handle(event("f1"))).action == "unchanged"

    async def test_a_file_that_comes_back_is_active_again(
        self,
        engines: tuple[AsyncEngine, AsyncEngine],
        sync: BusinessKnowledgeSync,
        files: FakeFiles,
    ) -> None:
        files.put("f1", "a.txt", b"x", F_HR, deleted=True)
        assert (await sync.handle(event("f1"))).action == "ignored"
        files.meta["f1"]["deleted"] = False
        await sync.handle(event("f1"))
        assert (await doc(engines[0], "f1"))["status"] == "active"

    async def test_the_same_file_id_under_another_tenant_id_is_refused(
        self, sync: BusinessKnowledgeSync, files: FakeFiles
    ) -> None:
        files.put("f1", "a.txt", b"x", F_HR)
        await sync.handle(event("f1", tenant=TENANT_A))
        with pytest.raises(BusinessContentError):
            await sync.handle(event("f1", tenant=TENANT_B))

    async def test_an_event_without_a_file_id_is_refused(self, sync: BusinessKnowledgeSync) -> None:
        bad = event("f1")
        bad["payload"] = {}
        with pytest.raises(BusinessContentError):
            await sync.handle(bad)

    async def test_a_library_document_must_belong_to_a_tenant(
        self, owner_conn: AsyncConnection
    ) -> None:
        with pytest.raises(ValueError):
            await register_document(
                owner_conn,
                NewDocument(
                    doc_code="X",
                    title="x",
                    domain="library",
                    version="current",
                    format="md",
                    access_level="folder",
                    folder_id=F_HR,
                ),  # fmt: skip
                actor=SYSTEM_ACTOR,
            )


def person(tenant: str | None, folders: set[str], roles: frozenset[str]) -> Identity:
    business = None
    if tenant:
        business = BusinessAccess(
            tenant_id=tenant,
            tenant_code="x",
            account_id="a",
            person_id=None,
            kind="staff",
            permissions=frozenset(),
            scopes_json="{}",
            perm_version=1,
            library_folders=frozenset(folders),
        )
    return Identity(
        user_id="u", username=None, name=None, roles=roles, campus_id=None, level=None,
        business=business,
    )  # fmt: skip


async def add(
    conn: AsyncConnection, code: str, tenant: str | None, folder: str | None, body: str,
    status: str = "active",
) -> None:  # fmt: skip
    document_id = await register_document(
        conn,
        NewDocument(
            doc_code=code, title=code, domain="library" if folder else "academics",
            version="current", format="md",
            access_level="folder" if folder else "students-and-staff",
            tenant_id=tenant, folder_id=folder, status=status,
        ),
        actor=SYSTEM_ACTOR,
    )  # fmt: skip
    await add_chunk(conn, document_id, chunk_index=0, chunk_text=body)


async def visible(conn: AsyncConnection, who: Identity) -> list[str]:
    rows = await conn.execute(select(chunks.c.doc_code).where(chunk_access_clause(who)))
    return sorted(r[0] for r in rows)


class TestFolderAccess:
    async def seed(self, conn: AsyncConnection) -> None:
        await add(conn, "PUB", TENANT_A, F_PUBLIC, "public handbook")
        await add(conn, "HR", TENANT_A, F_HR, "salary bands")
        await add(conn, "SEALED", TENANT_A, F_SEALED, "board minutes")
        await add(conn, "COURSE", TENANT_A, None, "syllabus")  # 课程大纲：没有文件夹
        await add(conn, "OTHER", TENANT_B, F_HR, "another tenant's file")
        await add(conn, "SAMPLE", None, None, "standalone policy")

    async def test_a_library_chunk_is_readable_only_through_its_folder(
        self, owner_conn: AsyncConnection
    ) -> None:
        await self.seed(owner_conn)
        # 角色是 hr（旧规则下什么都能读）也一样：不在文件夹列表里就读不到
        hr_without = person(TENANT_A, {F_PUBLIC}, frozenset({"hr", "staff"}))
        assert await visible(owner_conn, hr_without) == ["COURSE", "PUB"]
        member = person(TENANT_A, {F_PUBLIC, F_HR}, frozenset({"student"}))
        assert await visible(owner_conn, member) == [
            "COURSE",
            "HR",
            "PUB",
        ]  # 角色不够也读得到：以文件夹为准

    async def test_confidential_documents_need_the_folder_even_for_the_administrator(
        self, owner_conn: AsyncConnection
    ) -> None:
        await self.seed(owner_conn)
        admin = person(TENANT_A, set(), frozenset({"Admin"}))
        assert "SEALED" not in await visible(owner_conn, admin)
        granted = person(TENANT_A, {F_SEALED}, frozenset({"staff"}))
        assert "SEALED" in await visible(owner_conn, granted)

    async def test_an_empty_folder_list_reads_no_library_chunk(
        self, owner_conn: AsyncConnection
    ) -> None:
        await self.seed(owner_conn)
        assert await visible(owner_conn, person(TENANT_A, set(), frozenset({"staff"}))) == [
            "COURSE"
        ]

    async def test_another_tenants_chunk_is_never_readable_even_if_its_folder_id_is_listed(
        self, owner_conn: AsyncConnection
    ) -> None:
        await self.seed(owner_conn)
        who = person(TENANT_A, {F_PUBLIC, F_HR, F_SEALED}, frozenset({"staff"}))
        assert "OTHER" not in await visible(owner_conn, who)  # F_HR 在列表里，但那块属于 B 租户
        assert await visible(owner_conn, person(TENANT_B, {F_HR}, frozenset())) == ["OTHER"]

    async def test_standalone_askers_never_see_library_chunks(
        self, owner_conn: AsyncConnection, make_identity: Any
    ) -> None:
        await self.seed(owner_conn)
        assert await visible(owner_conn, make_identity({"hr", "finance", "staff"})) == ["SAMPLE"]

    async def test_a_draft_library_document_is_not_retrievable(
        self, owner_conn: AsyncConnection
    ) -> None:
        await add(owner_conn, "OLD", TENANT_A, F_PUBLIC, "removed file", status="draft")
        assert await visible(owner_conn, person(TENANT_A, {F_PUBLIC}, frozenset())) == []

    async def test_the_drift_view_stays_empty(self, owner_conn: AsyncConnection) -> None:
        await self.seed(owner_conn)
        count = (
            await owner_conn.execute(text("SELECT count(*) FROM ai.v_chunk_permission_drift"))
        ).scalar_one()
        assert count == 0
