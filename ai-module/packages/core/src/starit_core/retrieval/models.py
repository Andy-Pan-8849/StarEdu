"""文件：retrieval/models.py
作用：检索包里在各步骤之间传递的数据结构。
主要内容：
  - Candidate：一个命中的文本块，带它在每种检索里的名次和分数。
  - RetrievalDiagnostics：一次检索的统计（候选数、重排是否失败、耗时、被权限挡住的命中数）。
  - RetrievalResult：最终返回给调用方的结果（文本块列表 + 诊断）。
"""

from dataclasses import dataclass, field
from typing import Any
from uuid import UUID


@dataclass
class Candidate:
    """一个命中的文本块，以及它在各次检索里的名次和得分。

    keyword_*/vector_* 是单项检索的名次和分数；fused_score 是 RRF 融合后的分数；
    rerank_score 是模型重排给的 0-10 分。没参与的检索对应字段保持 None。
    """

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
        """把数据库查询的一行转成 Candidate（名次和分数由各检索步骤随后填入）。"""
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
    """一次检索的统计信息，用于评测、审计和排查，不会展示给用户。"""

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
    """检索的最终结果：按相关度排好序、已通过权限过滤的文本块，加上诊断信息。"""

    chunks: list[Candidate]
    diagnostics: RetrievalDiagnostics
