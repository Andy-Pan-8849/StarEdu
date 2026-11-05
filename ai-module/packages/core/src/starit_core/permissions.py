"""文件：permissions.py
作用：判断“谁能看哪些文本块”，是文档权限的唯一实现（设计见 docs/design/02 的 2.3、4 节）。
主要思想：权限在数据库查询里完成，而不是查出来再过滤。每个文本块自带 allowed_roles、
allowed_users、campus_scope、min_level_rank；`chunk_access_clause(identity)` 生成一个 WHERE 条件：
    (角色命中 或 指名用户)  且  (校区范围命中)  且  (职级够)  且  (状态可检索)
所有检索查询都必须带这个条件，这里没有“不带身份就能查文本块”的入口。
注意：Admin 和 RAGETLAdmin 只管系统/知识库，不在任何文档的角色表里，所以不能读受限内容。
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
# 文档的 access 级别 -> 能读的角色集合（登记文档时就展开成明确的角色列表）
ACCESS_LEVEL_ROLES: dict[str, frozenset[str]] = {
    "students-and-staff": frozenset({"student", "staff", "manager", "hr", "finance"}),
    "all-staff": frozenset({"staff", "manager", "hr", "finance"}),
    "staff": frozenset({"staff", "manager", "hr", "finance"}),
    "managers": frozenset({"manager", "hr", "finance"}),
    "finance-and-hr": frozenset({"hr", "finance"}),
    "hr-only": frozenset({"hr"}),
}

# Headquarters functions see every campus, for campus-scoped documents and structured data.
# 总部职能角色：能看所有校区的数据
COMPANY_WIDE_ROLES = frozenset({"hr", "finance"})

# Job levels on the three ladders (I instructor, S staff, M management) map to one grade so a
# document can require "grade 4 and above". See ai-module/sample-data/README.md.
# 三条职级线（I 讲师 / S 职能 / M 管理）映射到统一的“职等”，文档可要求“职等 ≥ N”
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
# 可检索的状态：现行(active)和已被取代(superseded)；草稿不可检索
RETRIEVABLE_STATUSES = ("active", "superseded")


def expand_access_level(access_level: str) -> list[str]:
    """把 access 级别展开成角色列表；未知级别抛 ValueError。"""
    try:
        return sorted(ACCESS_LEVEL_ROLES[access_level])
    except KeyError:
        raise ValueError(f"unknown access level: {access_level!r}") from None


def grade_of(level: str | None) -> int:
    """职级对应的职等；缺失或未知返回 0（最低）。"""
    return LEVEL_GRADE.get(level or "", 0)


def has_all_campuses(roles: Iterable[str]) -> bool:
    """角色里有总部职能（hr/finance）吗，即能否看所有校区。"""
    return bool(COMPANY_WIDE_ROLES & set(roles))


class Vector(UserDefinedType[list[float]]):
    """pgvector 的 vector 列类型（1536 维，对应 ai.chunk_embeddings）。"""

    cache_ok = True

    def get_col_spec(self, **_kw: object) -> str:
        return "vector(1536)"


# The one table object every chunk query is built on, so the access condition and the rest of
# the query always refer to the same table.
# 下面三个是检索用到的表的轻量定义：所有查询都基于同一个表对象，保证条件和查询指向同一张表
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
    """生成该调用者可读文本块的 WHERE 条件。

    参数：identity——提问者身份。
    返回：SQLAlchemy 条件：状态可检索 AND 授权(角色/指名用户) AND 校区范围 AND 职级。
    """
    roles = literal(sorted(identity.roles), ARRAY(Text))
    # 1. 授权：角色有交集，或被指名授权
    granted = or_(
        chunks.c.allowed_roles.overlap(roles),
        literal(identity.user_id) == any_(chunks.c.allowed_users),
    )
    # 2. 校区：文档对所有校区开放 / 包含用户校区 / 用户是总部职能
    campus_ok = or_(
        literal("all") == any_(chunks.c.campus_scope),
        literal(identity.campus_id) == any_(chunks.c.campus_scope)
        if identity.campus_id
        else literal(False),
        literal(has_all_campuses(identity.roles)),
    )
    # 3. 职级：文档没要求职等，或用户职等不低于要求
    grade_ok = or_(
        chunks.c.min_level_rank.is_(None),
        literal(grade_of(identity.level)) >= chunks.c.min_level_rank,
    )
    return and_(chunks.c.status.in_(RETRIEVABLE_STATUSES), granted, campus_ok, grade_ok)
