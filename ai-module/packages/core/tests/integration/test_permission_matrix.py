"""Differential test: the SQL filter must agree with an independent Python rule everywhere.

A grid of documents (access level x campus scope x status x grade requirement x named user)
is stored, then a grid of callers (role sets x campus x job level x user id) queries it. For
every caller the set of visible chunks from the database must equal what the plain Python
rule below says.
"""

import itertools
from collections.abc import Callable
from dataclasses import dataclass
from uuid import UUID

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncConnection
from starit_core.auth import Identity
from starit_core.documents import NewDocument, add_chunk, register_document
from starit_core.permissions import chunk_access_clause, chunks

pytestmark = pytest.mark.integration

# Independent of starit_core.permissions: written from the documented rules.
ROLES_BY_ACCESS = {
    "students-and-staff": {"student", "staff", "manager", "hr", "finance"},
    "all-staff": {"staff", "manager", "hr", "finance"},
    "staff": {"staff", "manager", "hr", "finance"},
    "managers": {"manager", "hr", "finance"},
    "finance-and-hr": {"hr", "finance"},
    "hr-only": {"hr"},
}
GRADE = {"S1": 1, "I1": 1, "S2": 2, "I2": 2, "S3": 3, "I3": 3, "I4": 4, "I5": 5, "M2": 6, "M3": 7}
LISTED_USER = "user-listed"


@dataclass(frozen=True)
class Doc:
    access: str
    campus_scope: tuple[str, ...]
    status: str
    min_rank: int | None
    users: tuple[str, ...]


def can_see(roles: set[str], campus: str | None, level: str | None, user: str, doc: Doc) -> bool:
    if doc.status not in ("active", "superseded"):
        return False
    granted = bool(ROLES_BY_ACCESS[doc.access] & roles) or user in doc.users
    campus_ok = (
        "all" in doc.campus_scope or campus in doc.campus_scope or bool({"hr", "finance"} & roles)
    )
    level_ok = doc.min_rank is None or GRADE.get(level or "", 0) >= doc.min_rank
    return granted and campus_ok and level_ok


DOCS = [
    Doc(access, scope, status, rank, users)
    for access, scope, status, rank, users in itertools.product(
        ROLES_BY_ACCESS,
        [("all",), ("SH",), ("BJ",)],
        ["active", "superseded", "draft"],
        [None, 4],
        [(), (LISTED_USER,)],
    )
]
ROLE_SETS = [
    set(),
    {"bogus"},
    *({r} for r in ("student", "staff", "manager", "hr", "finance", "Admin", "RAGETLAdmin")),
    {"staff", "manager"},
    {"student", "staff"},
    {"hr", "Admin"},
]
CAMPUSES = [None, "BJ", "SH", "CD"]
LEVELS = [None, "S2", "I5", "M3"]
USERS = [LISTED_USER, "user-other"]


async def seed(conn: AsyncConnection, make_identity: Callable[..., Identity]) -> dict[UUID, Doc]:
    admin = make_identity({"RAGETLAdmin"}, user_id="uploader")
    chunk_to_doc: dict[UUID, Doc] = {}
    for n, doc in enumerate(DOCS):
        document_id = await register_document(
            conn,
            NewDocument(
                doc_code=f"MX-{n:03d}", title=f"doc {n}", domain="hr", version="1.0", format="md",
                access_level=doc.access, status=doc.status, campus_scope=list(doc.campus_scope),
                min_level_rank=doc.min_rank, allowed_users=list(doc.users),
            ),
            actor=admin,
        )  # fmt: skip
        chunk_id = await add_chunk(conn, document_id, chunk_index=0, chunk_text=f"text {n}")
        chunk_to_doc[chunk_id] = doc
    return chunk_to_doc


async def test_sql_filter_agrees_with_the_independent_rule(
    owner_conn: AsyncConnection, make_identity: Callable[..., Identity]
) -> None:
    chunk_to_doc = await seed(owner_conn, make_identity)
    assert len(chunk_to_doc) == len(DOCS) == 216

    # Query exactly as the application will: as the ordinary application role.
    await owner_conn.execute(text("SET LOCAL ROLE ai_app"))
    checked = 0
    for roles, campus, level, user in itertools.product(ROLE_SETS, CAMPUSES, LEVELS, USERS):
        identity = make_identity(roles, user_id=user, campus_id=campus, level=level)
        rows = await owner_conn.execute(select(chunks.c.id).where(chunk_access_clause(identity)))
        got = {UUID(str(r[0])) for r in rows}
        expected = {
            cid for cid, d in chunk_to_doc.items() if can_see(roles, campus, level, user, d)
        }
        assert got == expected, (roles, campus, level, user)
        checked += 1
    assert checked == 12 * 4 * 4 * 2


async def test_management_roles_alone_see_nothing(
    owner_conn: AsyncConnection, make_identity: Callable[..., Identity]
) -> None:
    await seed(owner_conn, make_identity)
    await owner_conn.execute(text("SET LOCAL ROLE ai_app"))
    for roles in ({"Admin"}, {"RAGETLAdmin"}, {"Admin", "RAGETLAdmin"}, set(), {"bogus"}):
        identity = make_identity(roles, user_id="user-other", campus_id="BJ", level="M3")
        rows = await owner_conn.execute(select(chunks.c.id).where(chunk_access_clause(identity)))
        # Only chunks that name this exact user could appear; user-other is named by none.
        assert rows.all() == [], roles


async def test_a_named_user_sees_a_restricted_document(
    owner_conn: AsyncConnection, make_identity: Callable[..., Identity]
) -> None:
    await seed(owner_conn, make_identity)
    await owner_conn.execute(text("SET LOCAL ROLE ai_app"))
    # Admin has no role grant, but is named on documents that list user-listed.
    identity = make_identity({"Admin"}, user_id=LISTED_USER, campus_id="BJ", level="M3")
    rows = await owner_conn.execute(select(chunks.c.id).where(chunk_access_clause(identity)))
    assert len(rows.all()) > 0
