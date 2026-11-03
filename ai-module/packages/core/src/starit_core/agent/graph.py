"""The graph of docs/design/04-agent-flow.md, section 3.

Every step names the step that follows in the `route` it returns, and every route listed below
leads on to one of the six end steps, which is checked by a test that walks the graph.
"""

import logging
from collections.abc import Awaitable, Callable, Hashable
from typing import Any, cast

from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph

from starit_core.agent.nodes import AgentFailure, AgentNodes, _ctx
from starit_core.agent.state import AgentState

logger = logging.getLogger("starit.agent")

END_NODES = (
    "end_answered",
    "end_need_clarification",
    "end_no_permission",
    "end_not_found",
    "end_refused",
    "end_error",
)

# step -> the steps it may go to. `end_error` is always possible: a failing step routes there.
ROUTES: dict[str, tuple[str, ...]] = {
    "load_context": ("guard_input",),
    "guard_input": ("understand", "end_refused"),
    "understand": (
        "retrieve_docs",
        "plan_data_access",
        "chitchat_reply",
        "end_need_clarification",
        "end_not_found",
        "end_refused",
    ),
    "chitchat_reply": ("end_answered",),
    "retrieve_docs": ("grade_retrieval",),
    "grade_retrieval": ("generate", "rewrite_query", "end_no_permission", "end_not_found"),
    "rewrite_query": ("retrieve_docs",),
    "plan_data_access": ("call_data_tool", "run_sql"),
    "call_data_tool": ("answer_from_data", "run_sql", "end_no_permission", "end_not_found"),
    "run_sql": ("run_sql", "answer_from_data", "end_no_permission", "end_not_found"),
    "answer_from_data": ("end_answered",),
    "generate": ("verify_answer",),
    "verify_answer": ("end_answered", "end_not_found", "generate", "end_error"),
}

Step = Callable[[AgentState, RunnableConfig], Awaitable[AgentState]]


def _guarded(fn: Step) -> Step:
    """A step that fails ends the run in the `error` state instead of breaking the graph."""

    async def run(state: AgentState, config: RunnableConfig) -> AgentState:
        try:
            return await fn(state, config)
        except AgentFailure as failure:
            _ctx(config).totals.failure_detail = failure.detail or failure.reason
            return {"route": "end_error", "end_reason": failure.reason}
        except Exception as exc:
            logger.exception("step %s failed", fn.__name__)
            _ctx(config).totals.failure_detail = f"{type(exc).__name__}: {exc}"
            return {"route": "end_error", "end_reason": "internal"}

    run.__name__ = fn.__name__
    return run


def build_graph(nodes: AgentNodes) -> Any:
    builder: StateGraph[AgentState] = StateGraph(AgentState)
    for name in ROUTES:
        builder.add_node(name, cast(Any, _guarded(getattr(nodes, name))))
    for name in END_NODES:
        builder.add_node(name, cast(Any, getattr(nodes, name)))
    builder.add_edge(START, "load_context")
    for name, targets in ROUTES.items():
        allowed: dict[Hashable, str] = {target: target for target in (*targets, "end_error")}
        builder.add_conditional_edges(name, lambda s: s.get("route", "end_error"), allowed)
    for name in END_NODES:
        builder.add_edge(name, END)
    return builder.compile()
