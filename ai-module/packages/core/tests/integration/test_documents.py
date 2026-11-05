"""文件：测试——文档登记与权限变更（集成）
测什么：登记时权限级别展开成角色，文本块复制文档的权限字段；改权限/状态同步到所有块；
中途失败整体不变；未知权限级别或状态被拒绝；文档不存在时报告；删除会级联并写审计；
漂移视图能发现直接改库造成的不一致；编号可作为精确词被检索。
"""

from collections.abc import Callable
from datetime import date
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection
from starit_core import documents
from starit_core.auth import Identity
from starit_core.documents import (
    NewDocument,
    add_chunk,
    delete_document,
    register_document,
    set_status,
    update_access,
)

pytestmark = pytest.mark.integration


def new_doc(code: str = "HR-TST-001", **overrides: object) -> NewDocument:
    base = {
        "doc_code": code, "title": "Test policy", "domain": "hr", "version": "1.0",
        "format": "md", "access_level": "hr-only", "effective_date": date(2026, 1, 1),
    }  # fmt: skip
    base.update(overrides)
    return NewDocument(**base)  # type: ignore[arg-type]


async def drift(conn: AsyncConnection) -> list[object]:
    return list((await conn.execute(text("SELECT * FROM ai.v_chunk_permission_drift"))).all())


async def chunk_row(conn: AsyncConnection, chunk_id: UUID) -> dict[str, object]:
    row = await conn.execute(
        text("SELECT allowed_roles, status, campus_scope, min_level_rank "
             "FROM ai.document_chunks WHERE id = :id"),
        {"id": chunk_id},
    )  # fmt: skip
    return dict(row.mappings().one())


@pytest.fixture
def actor(make_identity: Callable[..., Identity]) -> Identity:
    return make_identity({"RAGETLAdmin"}, user_id="uploader-1")


async def test_register_expands_the_access_level_and_chunks_copy_it(
    owner_conn: AsyncConnection, actor: Identity
) -> None:
    doc_id = await register_document(
        owner_conn, new_doc(access_level="finance-and-hr"), actor=actor
    )
    chunk_id = await add_chunk(owner_conn, doc_id, chunk_index=0, chunk_text="Salary bands.")
    row = await chunk_row(owner_conn, chunk_id)
    assert row["allowed_roles"] == ["finance", "hr"]
    assert row["status"] == "active"
    assert await drift(owner_conn) == []


async def test_changing_access_updates_the_document_and_every_chunk(
    owner_conn: AsyncConnection, actor: Identity
) -> None:
    doc_id = await register_document(owner_conn, new_doc(), actor=actor)
    chunk_ids = [
        await add_chunk(owner_conn, doc_id, chunk_index=i, chunk_text=f"part {i}") for i in range(3)
    ]
    updated = await update_access(
        owner_conn, doc_id, actor=actor, access_level="managers", campus_scope=["SH"],
        min_level_rank=6,
    )  # fmt: skip
    assert updated == 3
    for chunk_id in chunk_ids:
        row = await chunk_row(owner_conn, chunk_id)
        assert row["allowed_roles"] == ["finance", "hr", "manager"]
        assert row["campus_scope"] == ["SH"]
        assert row["min_level_rank"] == 6
    assert await drift(owner_conn) == []

    await update_access(owner_conn, doc_id, actor=actor, clear_min_level=True)
    assert (await chunk_row(owner_conn, chunk_ids[0]))["min_level_rank"] is None


async def test_status_change_reaches_the_chunks(
    owner_conn: AsyncConnection, actor: Identity
) -> None:
    doc_id = await register_document(owner_conn, new_doc(), actor=actor)
    chunk_id = await add_chunk(owner_conn, doc_id, chunk_index=0, chunk_text="Old rule.")
    await set_status(owner_conn, doc_id, "superseded", actor=actor)
    assert (await chunk_row(owner_conn, chunk_id))["status"] == "superseded"
    assert await drift(owner_conn) == []


async def test_a_failure_part_way_changes_nothing(
    owner_conn: AsyncConnection, actor: Identity, monkeypatch: pytest.MonkeyPatch
) -> None:
    doc_id = await register_document(owner_conn, new_doc(), actor=actor)
    chunk_id = await add_chunk(owner_conn, doc_id, chunk_index=0, chunk_text="Rule.")

    async def broken_sync(*_args: object, **_kwargs: object) -> int:
        raise RuntimeError("chunk update failed")

    monkeypatch.setattr(documents, "_sync_chunks", broken_sync)
    with pytest.raises(RuntimeError):
        await update_access(owner_conn, doc_id, actor=actor, access_level="all-staff")

    # The document row was updated before the failure, then rolled back with the savepoint.
    access = (
        await owner_conn.execute(
            text("SELECT access_level, allowed_roles FROM ai.documents WHERE id = :id"),
            {"id": doc_id},
        )
    ).one()
    assert access == ("hr-only", ["hr"])
    assert (await chunk_row(owner_conn, chunk_id))["allowed_roles"] == ["hr"]
    assert await drift(owner_conn) == []
    audited = (
        await owner_conn.execute(
            text("SELECT count(*) FROM ai.audit_log WHERE action = 'doc.update_access'")
        )
    ).scalar_one()
    assert audited == 0  # a failed change leaves no audit record claiming it happened


async def test_unknown_access_level_or_status_is_rejected(
    owner_conn: AsyncConnection, actor: Identity
) -> None:
    with pytest.raises(ValueError):
        await register_document(owner_conn, new_doc(access_level="everyone"), actor=actor)
    with pytest.raises(ValueError):
        await register_document(owner_conn, new_doc(status="published"), actor=actor)
    doc_id = await register_document(owner_conn, new_doc(), actor=actor)
    with pytest.raises(ValueError):
        await set_status(owner_conn, doc_id, "archived", actor=actor)


async def test_missing_document_is_reported(owner_conn: AsyncConnection, actor: Identity) -> None:
    missing = UUID("00000000-0000-0000-0000-000000000000")
    with pytest.raises(LookupError):
        await update_access(owner_conn, missing, actor=actor, access_level="all-staff")
    with pytest.raises(LookupError):
        await delete_document(owner_conn, missing, actor=actor)


async def test_delete_removes_chunks_and_is_audited(
    owner_conn: AsyncConnection, actor: Identity
) -> None:
    doc_id = await register_document(owner_conn, new_doc(), actor=actor)
    await add_chunk(owner_conn, doc_id, chunk_index=0, chunk_text="Gone soon.")
    await delete_document(owner_conn, doc_id, actor=actor)
    chunks = (
        await owner_conn.execute(
            text("SELECT count(*) FROM ai.document_chunks WHERE document_id = :id"), {"id": doc_id}
        )
    ).scalar_one()
    assert chunks == 0
    actions = [
        r[0]
        for r in await owner_conn.execute(
            text("SELECT action FROM ai.audit_log WHERE user_id = 'uploader-1' ORDER BY id")
        )
    ]
    assert actions == ["doc.upload", "doc.delete"]


async def test_the_drift_view_catches_a_direct_edit(
    owner_conn: AsyncConnection, actor: Identity
) -> None:
    doc_id = await register_document(owner_conn, new_doc(), actor=actor)
    await add_chunk(owner_conn, doc_id, chunk_index=0, chunk_text="Rule.")
    await owner_conn.execute(
        text("UPDATE ai.document_chunks SET allowed_roles = '{student}' WHERE document_id = :id"),
        {"id": doc_id},
    )
    assert len(await drift(owner_conn)) == 1


async def test_identifiers_are_searchable_as_exact_terms(
    owner_conn: AsyncConnection, actor: Identity
) -> None:
    doc_id = await register_document(
        owner_conn, new_doc(access_level="students-and-staff"), actor=actor
    )
    await add_chunk(owner_conn, doc_id, chunk_index=0, chunk_text="Portal errors are listed here.",
                    identifiers=["ERR-PORTAL-403"])  # fmt: skip
    hits = (
        await owner_conn.execute(
            text(
                "SELECT count(*) FROM ai.document_chunks "
                "WHERE tsv @@ phraseto_tsquery('english', 'ERR-PORTAL-403')"
            )
        )
    ).scalar_one()
    assert hits == 1
