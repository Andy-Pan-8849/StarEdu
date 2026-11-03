"""The state that flows through the graph, and what is collected over a whole run."""

from dataclasses import dataclass, field
from typing import Any, TypedDict
from uuid import UUID

from starit_core.auth import Identity
from starit_core.retrieval.models import Candidate

END_STATES = ("answered", "need_clarification", "no_permission", "not_found", "refused", "error")


class AgentState(TypedDict, total=False):
    user_text: str
    # context
    history: list[dict[str, str]]
    session_mode: str
    pending_question: str | None
    clarify_count: int
    # understanding
    intent: str
    standalone_query: str
    clarification_question: str
    # retrieval
    chunks: list[Candidate]
    retrieval_attempts: int
    top_rerank_score: float | None
    restricted: bool
    # answer
    answer: str
    sufficient: bool
    generation_ok: bool
    cited: list[int]
    citations: list[dict[str, Any]]
    verify_attempts: int
    verify_feedback: str
    # data access
    plan_path: str
    tool_name: str
    tool_args: dict[str, Any]
    policy_excerpts: str
    sql_attempts: int
    sql_feedback: str
    data_rows: list[dict[str, Any]]
    data_row_count: int
    data_views: list[str]
    data_sql: str
    # routing and outcome
    route: str
    end_state: str
    end_reason: str | None
    reply: str


@dataclass
class RunTotals:
    """What the whole run used and saw: filled in by the nodes, read when the run is recorded."""

    llm_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    models: list[str] = field(default_factory=list)
    document_ids: list[str] = field(default_factory=list)
    restricted_keyword_hits: int = 0
    rerank_failed: bool = False
    failure_detail: str | None = None


@dataclass
class RunContext:
    """Everything a node needs besides the state: who is asking and the run's collectors."""

    identity: Identity
    conversation_id: UUID
    run_id: UUID
    totals: RunTotals
    chat: Any  # a budget-counting ChatClient
    reranker: Any
    data_tools: Any = None  # a DataToolsClient
    access_token: str | None = None  # the caller's raw JWT: in memory only, never logged
