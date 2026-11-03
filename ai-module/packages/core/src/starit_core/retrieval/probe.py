"""How much strongly matching content is hidden from this caller?

This is the one place a search runs WITHOUT the permission filter, so it is deliberately
narrow: it asks the database whether each top match is allowed for the caller and returns only
numbers (a count and best scores). It never returns text, titles or identifiers, and its result
must never be put in a prompt or shown to the user. It exists for the audit log and for choosing
between "no permission" and "not found" (docs/design/04-agent-flow.md, section 5.1).
"""

from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncConnection

from starit_core.auth import Identity
from starit_core.permissions import chunk_access_clause
from starit_core.retrieval.keyword import keyword_statement
from starit_core.retrieval.vector import vector_statement

PROBE_KEYWORD_K = 10
PROBE_VECTOR_K = 5


@dataclass(frozen=True)
class ProbeResult:
    restricted_keyword_hits: int
    restricted_best_keyword_score: float | None
    restricted_best_vector_similarity: float | None


async def probe_restricted(
    conn: AsyncConnection,
    identity: Identity,
    query: str,
    query_vector: Sequence[float] | None,
    model: str,
) -> ProbeResult:
    allowed = chunk_access_clause(identity).label("allowed")

    hits = 0
    best_keyword: float | None = None
    keyword = keyword_statement(query, PROBE_KEYWORD_K, None).add_columns(allowed)
    for row in (await conn.execute(keyword)).mappings():
        if not row["allowed"]:
            hits += 1
            best_keyword = max(best_keyword or 0.0, float(row["score"]))

    best_vector: float | None = None
    if query_vector is not None:
        vector = vector_statement(query_vector, model, PROBE_VECTOR_K, None).add_columns(allowed)
        for row in (await conn.execute(vector)).mappings():
            if not row["allowed"]:
                best_vector = max(best_vector or -1.0, 1.0 - float(row["distance"]))
    return ProbeResult(hits, best_keyword, best_vector)
