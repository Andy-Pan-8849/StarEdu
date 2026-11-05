"""文件：retrieval/vector.py
作用：向量检索——按余弦距离找出与问题语义最接近的文本块。
主要思想：问题和文本块都变成向量，pgvector 的 `<=>` 算余弦距离（越小越相似），
这里是精确扫描、不建索引（数据量小，结果可复现）。只比较同一个嵌入模型生成的向量。
和关键词检索一样，权限条件在 SQL 里先过滤。
"""

from collections.abc import Sequence
from typing import Any

from sqlalchemy import Float, and_, cast, literal, select
from sqlalchemy.ext.asyncio import AsyncConnection

from starit_core.auth import Identity
from starit_core.embeddings import vector_literal
from starit_core.permissions import (
    RETRIEVABLE_STATUSES,
    Vector,
    chunk_access_clause,
    chunk_embeddings,
    chunks,
    documents,
)
from starit_core.retrieval.keyword import _columns
from starit_core.retrieval.models import Candidate


def vector_statement(
    query_vector: Sequence[float], model: str, limit: int, access: Any | None
) -> Any:
    """构造向量检索的 SQL。

    参数：
      query_vector：问题的嵌入向量。
      model：嵌入模型名；只与同一模型生成的向量比较。
      limit：最多返回几条。
      access：权限条件；None 表示不过滤（仅供 probe.py 使用）。
    返回：按距离从小到大排序的 SQLAlchemy 查询。
    """
    distance = chunk_embeddings.c.embedding.op("<=>", return_type=Float)(
        cast(literal(vector_literal(query_vector)), Vector)
    ).label("distance")
    conditions = [
        chunk_embeddings.c.model == model,  # never compare vectors from different models
        chunks.c.status.in_(RETRIEVABLE_STATUSES),
    ]
    if access is not None:
        conditions.append(access)
    return (
        select(*_columns(), distance)
        .select_from(
            chunks.join(chunk_embeddings, chunk_embeddings.c.chunk_id == chunks.c.id).join(
                documents, documents.c.id == chunks.c.document_id
            )
        )
        .where(and_(*conditions))
        .order_by(distance, chunks.c.id)
        .limit(limit)
    )


async def vector_search(
    conn: AsyncConnection,
    identity: Identity,
    query_vector: Sequence[float],
    model: str,
    limit: int,
) -> list[Candidate]:
    """执行向量检索，返回带名次和相似度（1 - 距离）的候选。

    参数同 vector_statement，另需 identity（提问者身份，用于生成权限条件）和连接 conn。
    """
    statement = vector_statement(query_vector, model, limit, chunk_access_clause(identity))
    found: list[Candidate] = []
    for rank, row in enumerate((await conn.execute(statement)).mappings(), start=1):
        candidate = Candidate.from_row(row)
        candidate.vector_rank = rank
        candidate.vector_similarity = 1.0 - float(row["distance"])
        found.append(candidate)
    return found
