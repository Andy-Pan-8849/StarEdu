"""文件：agent/graph.py
作用：把各步骤连成 LangGraph 流程图（设计见 docs/design/04-agent-flow.md 第 3 节）。
主要思想：每个步骤执行完返回 `route`，告诉图下一步去哪；ROUTES 表列出每步允许去的地方，
build_graph 据此连线。任何步骤出错都统一走到 end_error，不会让整张图崩溃。
测试会遍历 ROUTES，保证每条路径最终都到达六个结局之一。
"""

import logging
import time
from collections.abc import Awaitable, Callable, Hashable
from typing import Any, cast

from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph

from starit_core import telemetry
from starit_core.agent.nodes import AgentFailure, AgentNodes, _ctx
from starit_core.agent.state import AgentState

logger = logging.getLogger("starit.agent")

# 六个结局节点：每次运行必然在其中之一结束
END_NODES = (
    "end_answered",
    "end_need_clarification",
    "end_no_permission",
    "end_not_found",
    "end_refused",
    "end_error",
)

# step -> the steps it may go to. `end_error` is always possible: a failing step routes there.
# 流程表：步骤 -> 它可能去的下一步（end_error 对所有步骤都隐含可达）
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
    """给步骤加保护：步骤出错就把运行带到 error 结局，而不是让整张图抛异常。

    同时为每个步骤记录链路 span 和耗时指标。AgentFailure 是步骤主动声明的失败（带原因），
    其他异常记为 internal 并写日志。
    """

    async def run(state: AgentState, config: RunnableConfig) -> AgentState:
        started = time.perf_counter()
        node = fn.__name__
        with telemetry.span(f"agent.{node}", {"agent.node": node}) as active:
            try:
                update = await fn(state, config)
            except AgentFailure as failure:
                _ctx(config).totals.failure_detail = failure.detail or failure.reason
                telemetry.fail(active, failure.reason)
                update = {"route": "end_error", "end_reason": failure.reason}
            except Exception as exc:
                logger.exception("step %s failed", node)
                _ctx(config).totals.failure_detail = f"{type(exc).__name__}: {exc}"
                telemetry.fail(active, "internal")
                update = {"route": "end_error", "end_reason": "internal"}
            active.set_attribute("agent.route", str(update.get("route", "")))
        telemetry.current().node_duration.record(time.perf_counter() - started, {"node": node})
        return update

    run.__name__ = fn.__name__
    return run


def build_graph(nodes: AgentNodes) -> Any:
    """构建并编译流程图。

    参数：nodes——AgentNodes 实例，ROUTES 里的每个名字对应它的一个方法。
    返回：可执行的编译后图。
    """
    builder: StateGraph[AgentState] = StateGraph(AgentState)
    for name in ROUTES:
        builder.add_node(name, cast(Any, _guarded(getattr(nodes, name))))
    for name in END_NODES:
        builder.add_node(name, cast(Any, getattr(nodes, name)))
    # 入口固定是 load_context；每步的下一跳由其返回的 route 决定
    builder.add_edge(START, "load_context")
    for name, targets in ROUTES.items():
        allowed: dict[Hashable, str] = {target: target for target in (*targets, "end_error")}
        builder.add_conditional_edges(name, lambda s: s.get("route", "end_error"), allowed)
    for name in END_NODES:
        # 结局节点连到图的终点
        builder.add_edge(name, END)
    return builder.compile()
