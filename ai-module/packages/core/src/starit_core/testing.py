"""Test doubles for the assistant: a chat client that answers by step, and a retrieval stub.

They live here, beside the other fakes (FakeChatClient, FakeEmbeddingClient, InMemoryStorage),
so that tests in different directories can share them.
"""

import asyncio
import json
from collections.abc import Callable, Mapping, Sequence
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from starit_core.agent.runtime import AgentRuntime, RunResult
from starit_core.auth import Identity
from starit_core.config import Settings
from starit_core.conversations import create_conversation
from starit_core.embeddings import FakeEmbeddingClient
from starit_core.llm import ChatResult
from starit_core.retrieval.models import Candidate, RetrievalDiagnostics, RetrievalResult

Answer = str | Exception | Callable[[Sequence[Mapping[str, str]], int], str]


def understand_json(
    intent: str = "doc_qa",
    query: str = "what is the policy?",
    *,
    clarify: str = "",
) -> str:
    return json.dumps(
        {
            "intent": intent,
            "standalone_query": query,
            "needs_clarification": bool(clarify),
            "clarification_question": clarify,
        }
    )


def generate_json(
    answer: str = "The policy says so [1].",
    *,
    sufficient: bool = True,
    citations: Sequence[int] = (1,),
) -> str:
    return json.dumps({"sufficient": sufficient, "answer": answer, "citations": list(citations)})


def step_of(messages: Sequence[Mapping[str, str]]) -> str:
    system = messages[0]["content"]
    if "intake step" in system:
        return "understand"
    if "You answer questions" in system:
        return "generate"
    if "Rewrite a search query" in system:
        return "rewrite"
    if "rank passages" in system:
        return "rerank"
    return "unknown"


class ScriptedChat:
    """Answers each assistant step from a script. For a step give a string, an exception to raise,
    a function of (messages, call number), or a list of those used in turn (the last repeats)."""

    def __init__(self, **script: Answer | Sequence[Answer]) -> None:
        self._script = script
        self.calls: list[tuple[str, list[dict[str, str]]]] = []
        self._counts: dict[str, int] = {}

    def steps(self) -> list[str]:
        return [step for step, _ in self.calls]

    def prompts(self, step: str) -> list[str]:
        return [messages[-1]["content"] for s, messages in self.calls if s == step]

    async def complete(
        self,
        messages: Sequence[Mapping[str, str]],
        *,
        model: str,
        json_mode: bool = False,
        max_tokens: int | None = None,
        request_timeout: float | None = None,
    ) -> ChatResult:
        step = step_of(messages)
        number = self._counts.get(step, 0)
        self._counts[step] = number + 1
        self.calls.append((step, [dict(m) for m in messages]))
        answer = self._script.get(step)
        if isinstance(answer, list | tuple):
            answer = answer[min(number, len(answer) - 1)]
        if answer is None:
            raise AssertionError(f"the test gave no answer for the {step!r} step")
        if isinstance(answer, Exception):
            raise answer
        text = answer(messages, number) if callable(answer) else answer
        return ChatResult(text=str(text), input_tokens=100, output_tokens=20)


def candidate(
    doc_code: str = "HR-REC-001",
    text: str = "The referral bonus is CNY 3,000.",
    *,
    version: str = "2.1",
    status: str = "active",
    title: str = "Recruitment Policy",
    tokens: int = 20,
) -> Candidate:
    return Candidate(
        chunk_id=uuid4(),
        document_id=uuid4(),
        doc_code=doc_code,
        title=title,
        version=version,
        status=status,
        heading_path=["4. Offers"],
        page=None,
        text=text,
        token_count=tokens,
    )


def retrieval_result(
    chunks: Sequence[Candidate],
    *,
    top_score: float | None = 10.0,
    restricted_hits: int = 0,
    restricted_score: float | None = None,
    rerank_failed: bool = False,
) -> RetrievalResult:
    chunks = list(chunks)
    if chunks and top_score is not None:
        chunks[0].rerank_score = top_score
    return RetrievalResult(
        chunks=chunks,
        diagnostics=RetrievalDiagnostics(
            mode="hybrid_rerank",
            restricted_keyword_hits=restricted_hits,
            restricted_best_keyword_score=restricted_score,
            rerank_failed=rerank_failed,
        ),
    )


class StubRetrieval:
    """Stands in for `retrieve`: returns the given results in turn (the last repeats)."""

    def __init__(self, *results: RetrievalResult | Exception, delay: float = 0.0) -> None:
        self._results = results
        self._delay = delay
        self.calls: list[dict[str, Any]] = []

    async def __call__(
        self, conn: Any, identity: Any, query: str, **kwargs: Any
    ) -> RetrievalResult:
        self.calls.append({"query": query, "identity": identity, **kwargs})
        if self._delay:
            await asyncio.sleep(self._delay)
        outcome = self._results[min(len(self.calls), len(self._results)) - 1]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class Harness:
    def __init__(self, owner: AsyncEngine, app: AsyncEngine, identity: Identity) -> None:
        self.owner, self.app, self.identity = owner, app, identity
        self.conversation_id: UUID | None = None

    async def runtime(self, chat: Any, retrieval: Any, **settings: Any) -> AgentRuntime:
        return AgentRuntime(
            engine=self.app,
            settings=Settings(_env_file=None, embedding_provider="fake", **settings),
            embedder=FakeEmbeddingClient(),
            chat=chat,
            retrieve_fn=retrieval,
        )

    async def conversation(self) -> UUID:
        if self.conversation_id is None:
            async with self.app.begin() as conn:
                self.conversation_id = (await create_conversation(conn, self.identity))["id"]
        assert self.conversation_id is not None
        return self.conversation_id

    async def ask(self, runtime: AgentRuntime, text_in: str) -> RunResult:
        return await runtime.run(self.identity, await self.conversation(), text_in)

    async def rows(self, sql: str, **params: Any) -> list[tuple[Any, ...]]:
        async with self.owner.connect() as conn:
            return [tuple(r) for r in (await conn.execute(text(sql), params)).all()]

    async def conversation_state(self) -> tuple[Any, ...]:
        return (
            await self.rows(
                "SELECT session_mode, pending_question, clarify_count, title "
                "FROM ai.conversations WHERE id = :c",
                c=self.conversation_id,
            )
        )[0]
