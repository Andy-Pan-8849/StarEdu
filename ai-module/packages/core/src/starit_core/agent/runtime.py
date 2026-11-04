"""Run the assistant for one message and record what happened.

However the graph ends (normally, by a failing step, by timeout or by a bug), exactly one run is
recorded with an end state and a reply.
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
from starit_core.agent.finish import finish_run
from starit_core.agent.graph import build_graph
from starit_core.agent.nodes import AgentNodes, BudgetedChat, RetrieveFn
from starit_core.agent.state import AgentState, RunContext, RunTotals
from starit_core.auth import Identity
from starit_core.config import Settings
from starit_core.embeddings import EmbeddingClient
from starit_core.llm import ChatClient
from starit_core.logging import run_id_var
from starit_core.retrieval import retrieve
from starit_core.retrieval.rerank import LLMReranker

logger = logging.getLogger("starit.agent")


@dataclass
class RunResult:
    run_id: UUID
    message_id: UUID
    content: str
    citations: list[dict[str, Any]] = field(default_factory=list)
    end_state: str = "error"
    end_reason: str | None = None


class AgentRuntime:
    def __init__(
        self,
        *,
        engine: AsyncEngine,
        settings: Settings,
        embedder: EmbeddingClient,
        chat: ChatClient,
        retrieve_fn: RetrieveFn = retrieve,
        data_tools: Any = None,
    ) -> None:
        self._data_tools = data_tools
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
    ) -> RunResult:
        run_id = uuid4()
        token = run_id_var.set(str(run_id))
        try:
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
                result = await self._run(identity, conversation_id, user_text, run_id, access_token)
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
    ) -> RunResult:
        settings = self._settings
        started_at = datetime.now(UTC)
        clock = time.perf_counter()
        totals = RunTotals()
        chat = BudgetedChat(
            self._chat, totals, settings.agent_max_llm_calls, settings.agent_llm_timeout_seconds
        )
        ctx = RunContext(
            identity=identity,
            conversation_id=conversation_id,
            run_id=run_id,
            totals=totals,
            chat=chat,
            reranker=LLMReranker(chat, settings.model_rerank, settings.rerank_passage_tokens),
            data_tools=self._data_tools,
            access_token=access_token,
        )
        config: dict[str, Any] = {
            "configurable": {"ctx": ctx},
            "recursion_limit": settings.agent_recursion_limit,
        }
        final: AgentState
        try:
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
        if "end_state" not in final:  # the graph stopped without reaching an end step
            final = self._failed("internal", run_id)

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
    def _failed(reason: str, run_id: UUID, detail: str = "") -> AgentState:
        return {
            "end_state": "error",
            "end_reason": reason,
            "reply": messages.ERROR.format(run_id=run_id),
        }
