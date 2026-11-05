"""文件：retrieval/keyword.py
作用：关键词检索，使用 PostgreSQL 全文检索（ts_rank_cd 打分）。
主要思想：
  1. 把问题转成 OR 查询：只要含问题里任一个词就算匹配，词越多排名越高。
     （AND 查询几乎找不到东西，因为问题里有很多无意义的虚词。）
  2. 精确编号加分：文本块的“编号列表”含问题里出现的编号（如 ERR-PORTAL-403、FIN-REIM-002）
     时加分，并且一定成为候选——编号这类词，关键词检索比向量检索更可靠。
  3. 如果块属于问题点名的那份文档（“FIN-REIM-002 说了什么”），再加一次分，
     让它排在只是顺带提到该编号的别份文档前面。
  4. 权限过滤写在 SQL 的 WHERE 里（见 permissions.chunk_access_clause），先过滤再排序。
"""

from typing import Any, Protocol

from sqlalchemy import Float, Text, and_, any_, case, cast, func, literal, or_, select
from sqlalchemy.dialects.postgresql import ARRAY, REGCONFIG, TSQUERY
from sqlalchemy.ext.asyncio import AsyncConnection

from starit_core.auth import Identity
from starit_core.ingest.identifiers import extract_identifiers
from starit_core.permissions import (
    RETRIEVABLE_STATUSES,
    chunk_access_clause,
    chunks,
    documents,
)
from starit_core.retrieval.models import Candidate

# 加分常量：与 ts_rank_cd 归一化后的 0~1 分数相加
IDENTIFIER_BONUS = 1.0  # the chunk lists an identifier that the question contains
OWN_DOCUMENT_BONUS = 1.0  # ... and the chunk belongs to the document with that number
_NORMALIZE_LENGTH_RANK = 32  # ts_rank_cd normalisation option: rank / (rank + 1)


class KeywordSearcher(Protocol):
    """关键词检索器的接口（协议）：评测可以换成别的实现来做对比实验。"""

    async def search(
        self, conn: AsyncConnection, identity: Identity, query: str, limit: int
    ) -> list[Candidate]: ...


def or_tsquery(query: str) -> Any:
    """用 plainto_tsquery 生成查询，再把其中的 AND（&）替换成 OR（|）。"""
    plain = func.plainto_tsquery(cast(literal("english"), REGCONFIG), query)
    return cast(func.replace(cast(plain, Text), "&", "|"), TSQUERY)


def _columns() -> list[Any]:
    """关键词检索和向量检索都要取出的文本块列（保证两边结果格式一致）。"""
    return [
        chunks.c.id,
        chunks.c.document_id,
        chunks.c.doc_code,
        documents.c.title,
        chunks.c.version,
        chunks.c.status,
        chunks.c.heading_path,
        chunks.c.page,
        chunks.c.text,
        chunks.c.token_count,
    ]


def keyword_statement(
    query: str, limit: int, access: Any | None, identifier_boost: bool = True
) -> Any:
    """构造关键词检索的 SQL。

    参数：
      query：用户问题。
      limit：最多返回几条。
      access：权限条件；None 表示不过滤，只给 probe.py 的“被挡住了多少”统计使用，
        结果不会离开检索包。
      identifier_boost：是否启用编号加分（评测里用来做对比）。
    返回：可执行的 SQLAlchemy 查询。
    """
    # 第 1 步：问题 -> OR 全文查询；同时从问题里找出编号
    tsquery = or_tsquery(query)
    identifiers = extract_identifiers(query) if identifier_boost else []
    id_array = literal(identifiers, ARRAY(Text))
    has_identifier = chunks.c.identifiers.overlap(id_array) if identifiers else literal(False)
    is_named_document = chunks.c.doc_code == any_(id_array) if identifiers else literal(False)
    # 第 2 步：全文得分 + 编号加分 + 点名文档加分
    rank = func.ts_rank_cd(chunks.c.tsv, tsquery, _NORMALIZE_LENGTH_RANK)
    bonus = case((has_identifier, literal(IDENTIFIER_BONUS)), else_=literal(0.0)) + case(
        (is_named_document, literal(OWN_DOCUMENT_BONUS)), else_=literal(0.0)
    )
    score = (rank + bonus).label("score")
    # 命中条件：只检索现行/可检索状态的块；含任一查询词，或含问题里的编号
    conditions = [
        chunks.c.status.in_(RETRIEVABLE_STATUSES),
        or_(chunks.c.tsv.bool_op("@@")(tsquery), has_identifier),
    ]
    # 权限条件在这里并入 WHERE，所以不可读的文本块根本不会进入排序
    if access is not None:
        conditions.append(access)
    return (
        select(*_columns(), cast(score, Float).label("score"))
        .select_from(chunks.join(documents, documents.c.id == chunks.c.document_id))
        .where(and_(*conditions))
        .order_by(score.desc(), chunks.c.id)
        .limit(limit)
    )


class TsRankKeywordSearcher:
    """默认的关键词检索器：执行 keyword_statement 并记录每条结果的名次和分数。"""

    def __init__(self, identifier_boost: bool = True) -> None:
        self._identifier_boost = identifier_boost

    async def search(
        self, conn: AsyncConnection, identity: Identity, query: str, limit: int
    ) -> list[Candidate]:
        statement = keyword_statement(
            query, limit, chunk_access_clause(identity), self._identifier_boost
        )
        found: list[Candidate] = []
        for rank, row in enumerate((await conn.execute(statement)).mappings(), start=1):
            candidate = Candidate.from_row(row)
            candidate.keyword_rank = rank
            candidate.keyword_score = float(row["score"])
            found.append(candidate)
        return found
