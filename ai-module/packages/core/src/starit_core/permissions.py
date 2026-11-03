"""Who may see which document chunks (docs/design/02-data-model.md, sections 2.3 and 4).

Every retrieval query must apply `chunk_access_clause`. There is no way to build a chunk
query here without an identity.
"""

from collections.abc import Iterable

from sqlalchemy import ColumnElement, Date, Integer, and_, any_, column, literal, or_, table
from sqlalchemy.dialects.postgresql import ARRAY, TSVECTOR, UUID
from sqlalchemy.types import SmallInteger, Text, UserDefinedType

from starit_core.auth import Identity

# Policy documents are controlled by role. `access` in documents/manifest.csv is expanded to an
# explicit role list when a document is registered, so a query only does set arithmetic.
# Admin and RAGETLAdmin manage the system and the knowledge base; they do not appear here, so
# they cannot read restricted content unless they also hold a business role.
ACCESS_LEVEL_ROLES: dict[str, frozenset[str]] = {
    "students-and-staff": frozenset({"student", "staff", "manager", "hr", "finance"}),
    "all-staff": frozenset({"staff", "manager", "hr", "finance"}),
    "staff": frozenset({"staff", "manager", "hr", "finance"}),
    "managers": frozenset({"manager", "hr", "finance"}),
    "finance-and-hr": frozenset({"hr", "finance"}),
    "hr-only": frozenset({"hr"}),
}

# Headquarters functions see every campus, for campus-scoped documents and structured data.
COMPANY_WIDE_ROLES = frozenset({"hr", "finance"})

# Job levels on the three ladders (I instructor, S staff, M management) map to one grade so a
# document can require "grade 4 and above". See ai-module/sample-data/README.md.
LEVEL_GRADE: dict[str, int] = {
    "S1": 1, "I1": 1,
    "S2": 2, "I2": 2,
    "S3": 3, "I3": 3,
    "I4": 4,
    "I5": 5,
    "M2": 6,
    "M3": 7,
}  # fmt: skip

# Chunks of these statuses can be retrieved. Superseded versions stay searchable and are
# labelled; drafts are not.
RETRIEVABLE_STATUSES = ("active", "superseded")


def expand_access_level(access_level: str) -> list[str]:
    try:
        return sorted(ACCESS_LEVEL_ROLES[access_level])
    except KeyError:
        raise ValueError(f"unknown access level: {access_level!r}") from None


def grade_of(level: str | None) -> int:
    """The grade for a job level; 0 when the level is missing or unknown."""
    return LEVEL_GRADE.get(level or "", 0)


def has_all_campuses(roles: Iterable[str]) -> bool:
    return bool(COMPANY_WIDE_ROLES & set(roles))


class Vector(UserDefinedType[list[float]]):
    """pgvector's `vector` column type (1536 wide, see ai.chunk_embeddings)."""

    cache_ok = True

    def get_col_spec(self, **_kw: object) -> str:
        return "vector(1536)"


# The one table object every chunk query is built on, so the access condition and the rest of
# the query always refer to the same table.
chunks = table(
    "document_chunks",
    column("id", UUID),
    column("document_id", UUID),
    column("chunk_index", Integer),
    column("text", Text),
    column("heading_path", ARRAY(Text)),
    column("page", Integer),
    column("token_count", Integer),
    column("identifiers", ARRAY(Text)),
    column("tsv", TSVECTOR),
    column("allowed_roles", ARRAY(Text)),
    column("allowed_users", ARRAY(Text)),
    column("campus_scope", ARRAY(Text)),
    column("min_level_rank", SmallInteger),
    column("status", Text),
    column("effective_date", Date),
    column("doc_code", Text),
    column("version", Text),
    schema="ai",
)
documents = table(
    "documents",
    column("id", UUID),
    column("title", Text),
    schema="ai",
)
chunk_embeddings = table(
    "chunk_embeddings",
    column("chunk_id", UUID),
    column("model", Text),
    column("embedding", Vector),
    schema="ai",
)


def chunk_access_clause(identity: Identity) -> ColumnElement[bool]:
    """The WHERE condition for ai.document_chunks that this caller is allowed to read.

    granted (role, or named user)  AND  campus scope  AND  grade
    """
    roles = literal(sorted(identity.roles), ARRAY(Text))
    granted = or_(
        chunks.c.allowed_roles.overlap(roles),
        literal(identity.user_id) == any_(chunks.c.allowed_users),
    )
    campus_ok = or_(
        literal("all") == any_(chunks.c.campus_scope),
        literal(identity.campus_id) == any_(chunks.c.campus_scope)
        if identity.campus_id
        else literal(False),
        literal(has_all_campuses(identity.roles)),
    )
    grade_ok = or_(
        chunks.c.min_level_rank.is_(None),
        literal(grade_of(identity.level)) >= chunks.c.min_level_rank,
    )
    return and_(chunks.c.status.in_(RETRIEVABLE_STATUSES), granted, campus_ok, grade_ok)
