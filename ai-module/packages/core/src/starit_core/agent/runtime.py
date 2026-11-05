"""文件：agent/runtime.py
作用：为一条用户消息运行一次助手，并把结果记录下来——助手对外的唯一入口。
主要思想：无论图怎么结束（正常结束、某步失败、超时、程序错误），都恰好记录一次运行，
带结局和回复，调用方永远拿到一个结果，不会没有回应。
流式：传入 on_event 时，运行过程中会发事件（见 events.py），并在结束时把已展示的文字
与最终记录的回复对齐（_finish_stream）。
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from langgraph.errors import GraphRecursionError
from sqlalchemy.ext.asyncio import AsyncEngine

from starit_core import telemetry
from starit_core.agent import messages
from starit_core.agent.events import RunEmitter, Sink
from starit_core.agent.finish import finish_run
from starit_core.agent.graph import build_graph
from starit_core.agent.nodes import AgentNodes, BudgetedChat, RetrieveFn
from starit_core.agent.state import AgentState, RunContext, RunTotals
from starit_core.auth import Identity
from starit_core.config import Settings
from starit_core.cost import DailyBudget
from starit_core.embeddings import EmbeddingClient
from starit_core.llm import ChatClient
from starit_core.logging import run_id_var
from starit_core.retrieval import retrieve
from starit_core.retrieval.rerank import LLMReranker

logger = logging.getLogger("starit.agent")


@dataclass
class RunResult:
    """一次运行的结果：运行 ID、助手消息 ID、回复文字、引用、结局和结局原因。"""

    run_id: UUID
    message_id: UUID
    content: str
    citations: list[dict[str, Any]] = field(default_factory=list)
    end_state: str = "error"
    end_reason: str | None = None


class AgentRuntime:
    """助手运行时。构造时把依赖（数据库、配置、嵌入/聊天客户端、检索函数、数据工具、预算）
    注入进来，并编译好流程图；之后每条消息调用一次 run。
    """

    def __init__(
        self,
        *,
        engine: AsyncEngine,
        settings: Settings,
        embedder: EmbeddingClient,
        chat: ChatClient,
        retrieve_fn: RetrieveFn = retrieve,
        data_tools: Any = None,
        budget: DailyBudget | None = None,
    ) -> None:
        self._data_tools = data_tools
        self._budget = budget
        self._engine = engine
        self._settings = settings
        self._chat = chat
        self._graph = build_graph(
            AgentNodes(engine=engine, settings=settings, embedder=embedder, retrieve_fn=retrieve_fn)
        )

    @property
    def graph(self) -> Any:
        return self._graph

    async def run(
        self,
        identity: Identity,
        conversation_id: UUID,
        user_text: str,
        *,
        access_token: str | None = None,
        on_event: Sink | None = None,
    ) -> RunResult:
        """为一条消息运行助手。

        参数：
          identity：提问者身份（所有权限判断的依据）；conversation_id：所在会话；user_text：用户原文。
          access_token：调用方的原始令牌，只在内存里传给数据工具，不记录、不落库。
          on_event：有客户端在监听时传入。运行会边做边发事件，并以 run.ended 结束。
        返回：RunResult。
        """
        # 每次运行有自己的 ID，贯穿日志、链路、审计和事件
        run_id = uuid4()
        emitter = RunEmitter(on_event) if on_event is not None else None
        token = run_id_var.set(str(run_id))
        try:
            if emitter is not None:
                await emitter.event("run.started", {"run_id": str(run_id)})
            # 整个运行放在一个链路 span 里，结束时写入结局
            with telemetry.span(
                "agent.run",
                {
                    "run_id": str(run_id),
                    "conversation_id": str(conversation_id),
                    "user.roles": sorted(identity.roles),
                    "langfuse.session.id": str(conversation_id),
                    "langfuse.trace.name": "assistant run",
                },
            ) as active:
                # 真正执行：跑图 -> 落库 -> 得到结果
                result = await self._run(
                    identity, conversation_id, user_text, run_id, access_token, emitter
                )
                if emitter is not None:
                    # 流式收尾：对齐已展示的文字，补发引用和结束事件
                    await self._finish_stream(emitter, result)
                active.set_attribute("agent.end_state", result.end_state)
                active.set_attribute("agent.end_reason", result.end_reason or "")
                if result.end_state == "error":
                    telemetry.fail(active, result.end_reason or "error")
            telemetry.current().runs.add(
                1, {"end_state": result.end_state, "end_reason": result.end_reason or ""}
            )
            return result
        finally:
            run_id_var.reset(token)

    async def _run(
        self,
        identity: Identity,
        conversation_id: UUID,
        user_text: str,
        run_id: UUID,
        access_token: str | None,
        emitter: RunEmitter | None = None,
    ) -> RunResult:
        """执行流程图并落库，返回结果。

        超时、递归过深（步骤太多）、任何异常都会转成 error 结局，而不是向外抛，
        这样“恰好记录一次运行”的保证永远成立。
        """
        settings = self._settings
        started_at = datetime.now(UTC)
        clock = time.perf_counter()
        # 本次运行的统计容器，各步骤往里累加
        totals = RunTotals()
        # 包装模型客户端：计数、限次、计费
        chat = BudgetedChat(
            self._chat,
            totals,
            settings.agent_max_llm_calls,
            settings.agent_llm_timeout_seconds,
            self._budget,
        )
        # 步骤需要的上下文：身份、客户端、重排器、事件发送器
        ctx = RunContext(
            identity=identity,
            conversation_id=conversation_id,
            run_id=run_id,
            totals=totals,
            chat=chat,
            reranker=LLMReranker(chat, settings.model_rerank, settings.rerank_passage_tokens),
            data_tools=self._data_tools,
            access_token=access_token,
            emitter=emitter,
        )
        config: dict[str, Any] = {
            "configurable": {"ctx": ctx},
            "recursion_limit": settings.agent_recursion_limit,
        }
        final: AgentState
        try:
            # 带总超时地运行整张图
            final = await asyncio.wait_for(
                self._graph.ainvoke({"user_text": user_text}, config),
                timeout=settings.agent_run_timeout_seconds,
            )
        except TimeoutError:
            final = self._failed(
                "timeout", run_id, f"no answer within {settings.agent_run_timeout_seconds}s"
            )
            totals.failure_detail = final["reply"] and "timeout"
        except GraphRecursionError:
            final = self._failed("step_limit", run_id)
        except Exception as exc:
            logger.exception("the assistant failed")
            totals.failure_detail = f"{type(exc).__name__}: {exc}"
            final = self._failed("internal", run_id)
        # 图没走到任何结局节点（不应发生）：按内部错误处理
        if "end_state" not in final:  # the graph stopped without reaching an end step
            final = self._failed("internal", run_id)

        # 落库：运行、消息、审计一个事务写完
        message_id = await finish_run(
            self._engine,
            identity=identity,
            conversation_id=conversation_id,
            run_id=run_id,
            user_text=user_text,
            started_at=started_at,
            final=final,
            totals=totals,
            latency_ms=int((time.perf_counter() - clock) * 1000),
        )
        return RunResult(
            run_id=run_id,
            message_id=message_id,
            content=final["reply"],
            citations=final.get("citations", []),
            end_state=final["end_state"],
            end_reason=final.get("end_reason"),
        )

    @staticmethod
    async def _finish_stream(emitter: RunEmitter, result: RunResult) -> None:
        """让客户端看到的文字与记录的回复一致，然后结束这次运行。

        没流式输出过的回复（反问、拒绝、错误文案）一次性发出；流出的文字若是回复的前缀就补发其余；
        流出的文字最终没被采用就先撤回再发新的；只差首尾空白的不值得撤回。
        最后发 citations 和 run.ended 事件。
        """
        shown, reply = emitter.open_text, result.content
        if not shown:
            await emitter.delta(reply)
        elif shown == shown.lstrip() and shown.strip() == reply:
            pass
        elif shown == shown.lstrip() and reply.startswith(shown):
            await emitter.delta(reply[len(shown) :])
        else:
            await emitter.retract("replaced")
            await emitter.delta(reply)
        if result.citations:
            await emitter.event("citations", {"citations": result.citations})
        await emitter.event(
            "run.ended",
            {
                "run_id": str(result.run_id),
                "message_id": str(result.message_id),
                "end_state": result.end_state,
                "end_reason": result.end_reason,
                "content": reply,
            },
        )

    @staticmethod
    def _failed(reason: str, run_id: UUID, detail: str = "") -> AgentState:
        """构造一个 error 结局的最终状态（回复里带运行 ID）。"""
        return {
            "end_state": "error",
            "end_reason": reason,
            "reply": messages.ERROR.format(run_id=run_id),
        }
