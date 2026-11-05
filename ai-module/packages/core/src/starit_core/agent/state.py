"""文件：agent/state.py
作用：定义流程图里流转的“状态”，以及一次运行累计的统计和上下文。
主要内容：
  - END_STATES：一次运行可能的六种结局。
  - AgentState：在各步骤之间传递的状态（字典），按“上下文/理解/检索/回答/数据/路由”分组。
  - RunTotals：整次运行用了多少模型调用、token、费用，看到了哪些文档（运行结束时写入审计）。
  - RunContext：步骤需要的、不属于状态的东西（提问者身份、模型客户端、事件发送器等）。
主要思想：状态只放“业务数据”，对象型依赖放进 RunContext，通过 LangGraph 的 config 传给步骤。
"""

from dataclasses import dataclass, field
from typing import Any, TypedDict
from uuid import UUID

from starit_core.auth import Identity
from starit_core.retrieval.models import Candidate

# 六种结局：已回答 / 需要澄清 / 无权限 / 没找到 / 拒绝 / 出错。
END_STATES = ("answered", "need_clarification", "no_permission", "not_found", "refused", "error")


class AgentState(TypedDict, total=False):
    """流程图里流转的状态。total=False：每个字段都可以暂时不存在，由各步骤逐步填入。"""

    # 用户这一轮输入的原文
    user_text: str
    # —— 上下文：由 load_context 从数据库读入
    # context
    history: list[dict[str, str]]
    session_mode: str
    pending_question: str | None
    clarify_count: int
    # —— 理解：由 understand 填入（意图、改写成独立问题、需要时的反问）
    # understanding
    intent: str
    standalone_query: str
    clarification_question: str
    # —— 检索：文档类问题的检索结果与评分
    # retrieval
    chunks: list[Candidate]
    retrieval_attempts: int
    top_rerank_score: float | None
    restricted: bool
    # —— 回答：生成、引用、校验相关
    # answer
    answer: str
    sufficient: bool
    generation_ok: bool
    cited: list[int]
    citations: list[dict[str, Any]]
    verify_attempts: int
    verify_feedback: str
    # —— 数据访问：数据类问题的计划、SQL/工具调用与结果
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
    # —— 路由与结局：下一步去哪、怎么结束、最终回复
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
    cost_usd: float = 0.0
    fallbacks: int = 0


@dataclass
class RunContext:
    """步骤需要、但不属于状态的东西：谁在问、会话/运行 ID、模型客户端和本次运行的统计。"""

    identity: Identity
    conversation_id: UUID
    run_id: UUID
    totals: RunTotals
    chat: Any  # a budget-counting ChatClient
    reranker: Any
    data_tools: Any = None  # a DataToolsClient
    emitter: Any = None  # a RunEmitter when a client is listening, else None
    access_token: str | None = None  # the caller's raw JWT: in memory only, never logged
