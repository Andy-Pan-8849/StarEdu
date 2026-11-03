from dataclasses import dataclass, field
from typing import Any
from uuid import UUID


@dataclass
class Candidate:
    """A chunk that matched, with where it ranked in each search and its scores."""

    chunk_id: UUID
    document_id: UUID
    doc_code: str
    title: str
    version: str
    status: str
    heading_path: list[str]
    page: int | None
    text: str
    token_count: int
    keyword_rank: int | None = None
    keyword_score: float | None = None
    vector_rank: int | None = None
    vector_similarity: float | None = None
    fused_score: float = 0.0
    rerank_score: float | None = None

    @classmethod
    def from_row(cls, row: Any) -> "Candidate":
        return cls(
            chunk_id=row["id"],
            document_id=row["document_id"],
            doc_code=row["doc_code"],
            title=row["title"],
            version=row["version"],
            status=row["status"],
            heading_path=list(row["heading_path"] or []),
            page=row["page"],
            text=row["text"],
            token_count=row["token_count"],
        )


@dataclass
class RetrievalDiagnostics:
    mode: str
    keyword_candidates: int = 0
    vector_candidates: int = 0
    rerank_failed: bool = False
    rerank_error: str | None = None
    rerank_input_tokens: int = 0
    rerank_output_tokens: int = 0
    # How much strongly matching content this caller may not read. Numbers only, never text:
    # they are for the audit log and for choosing between "no permission" and "not found".
    restricted_keyword_hits: int = 0
    restricted_best_keyword_score: float | None = None
    restricted_best_vector_similarity: float | None = None
    timings_ms: dict[str, float] = field(default_factory=dict)


@dataclass
class RetrievalResult:
    chunks: list[Candidate]
    diagnostics: RetrievalDiagnostics
