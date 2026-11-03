"""Vector search: cosine distance over the stored embeddings (an exact scan, no index)."""

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
    """The vector query. `access` None builds the unfiltered probe version (see probe.py)."""
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
    statement = vector_statement(query_vector, model, limit, chunk_access_clause(identity))
    found: list[Candidate] = []
    for rank, row in enumerate((await conn.execute(statement)).mappings(), start=1):
        candidate = Candidate.from_row(row)
        candidate.vector_rank = rank
        candidate.vector_similarity = 1.0 - float(row["distance"])
        found.append(candidate)
    return found
