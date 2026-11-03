"""Keyword search with Postgres full-text search (ts_rank_cd).

The question becomes an OR query: a chunk matches when it has any of the question's terms, and
chunks with more of them rank higher. (An AND query would find almost nothing, because a
question contains many filler words.) Chunks whose exact-identifier list contains an identifier
from the question (ERR-PORTAL-403, FIN-REIM-002...) get a bonus and are always candidates. A
chunk of the very document the question names ("What does FIN-REIM-002 say?") gets a second
bonus, so it comes before a chunk of another document that only mentions that number.
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

IDENTIFIER_BONUS = 1.0  # the chunk lists an identifier that the question contains
OWN_DOCUMENT_BONUS = 1.0  # ... and the chunk belongs to the document with that number
_NORMALIZE_LENGTH_RANK = 32  # ts_rank_cd normalisation option: rank / (rank + 1)


class KeywordSearcher(Protocol):
    async def search(
        self, conn: AsyncConnection, identity: Identity, query: str, limit: int
    ) -> list[Candidate]: ...


def or_tsquery(query: str) -> Any:
    """plainto_tsquery with its AND turned into OR."""
    plain = func.plainto_tsquery(cast(literal("english"), REGCONFIG), query)
    return cast(func.replace(cast(plain, Text), "&", "|"), TSQUERY)


def _columns() -> list[Any]:
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


def keyword_statement(query: str, limit: int, access: Any | None) -> Any:
    """The keyword query. `access` is the permission condition; None builds the unfiltered
    probe version (see probe.py), which never leaves this package."""
    tsquery = or_tsquery(query)
    identifiers = extract_identifiers(query)
    id_array = literal(identifiers, ARRAY(Text))
    has_identifier = chunks.c.identifiers.overlap(id_array) if identifiers else literal(False)
    is_named_document = chunks.c.doc_code == any_(id_array) if identifiers else literal(False)
    rank = func.ts_rank_cd(chunks.c.tsv, tsquery, _NORMALIZE_LENGTH_RANK)
    bonus = case((has_identifier, literal(IDENTIFIER_BONUS)), else_=literal(0.0)) + case(
        (is_named_document, literal(OWN_DOCUMENT_BONUS)), else_=literal(0.0)
    )
    score = (rank + bonus).label("score")
    conditions = [
        chunks.c.status.in_(RETRIEVABLE_STATUSES),
        or_(chunks.c.tsv.bool_op("@@")(tsquery), has_identifier),
    ]
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
    async def search(
        self, conn: AsyncConnection, identity: Identity, query: str, limit: int
    ) -> list[Candidate]:
        statement = keyword_statement(query, limit, chunk_access_clause(identity))
        found: list[Candidate] = []
        for rank, row in enumerate((await conn.execute(statement)).mappings(), start=1):
            candidate = Candidate.from_row(row)
            candidate.keyword_rank = rank
            candidate.keyword_score = float(row["score"])
            found.append(candidate)
        return found
