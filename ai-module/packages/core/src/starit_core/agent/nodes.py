"""The steps of the assistant. Each takes the graph state and returns what changes."""

import json
import logging
import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any

from langchain_core.runnables import RunnableConfig
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from starit_core.agent import messages
from starit_core.agent.prompts import PROMPT_VERSIONS, prompt_text
from starit_core.agent.state import AgentState, RunContext
from starit_core.config import Settings
from starit_core.conversations import recent_turns
from starit_core.dataaccess.schema import schema_prompt
from starit_core.dataaccess.sqlguard import AccessDenied, SqlRejected, validate_sql
from starit_core.embeddings import EmbeddingClient
from starit_core.llm import ChatClient, ChatError, ChatResult, parse_json_object
from starit_core.retrieval import RetrievalResult, retrieve
from starit_core.retrieval.models import Candidate
from starit_core.sqlaccess import run_as_identity

logger = logging.getLogger("starit.agent")

PLANNED_TOOLS = (
    "list_assignments",
    "list_students",
    "get_student_progress",
    "get_expense_claim_status",
    "list_my_expense_claims",
)
POLICY_EXCERPTS = 3
INTENTS = ("doc_qa", "data_query", "action", "chitchat", "out_of_scope")
MAX_ANSWER_CHARS = 4000
_CITATION = re.compile(r"\[(\d+)\]")
# Only the plainest attempts; the real protection is that the model is never given anything the
# user may not read.
_INJECTION = re.compile(
    r"ignore (all |any )?(the )?(previous|prior|above) (instructions|rules|prompts?)"
    r"|disregard (your|the) (instructions|rules|system prompt)"
    r"|(reveal|show|print|repeat) (me )?(your|the) (system )?(prompt|instructions)",
    re.IGNORECASE,
)

RetrieveFn = Callable[..., Awaitable[RetrievalResult]]


class AgentFailure(Exception):
    """A step failed in a way that ends the run in the `error` state."""

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(detail or reason)
        self.reason = reason
        self.detail = detail


class BudgetedChat:
    """Wraps the chat client for one run: counts calls and tokens, enforces the call limit."""

    def __init__(
        self, inner: ChatClient, ctx_totals: Any, limit: int, request_timeout: float
    ) -> None:
        self._inner = inner
        self._totals = ctx_totals
        self._limit = limit
        self._timeout = request_timeout

    async def complete(
        self,
        messages: Sequence[Mapping[str, str]],
        *,
        model: str,
        json_mode: bool = False,
        max_tokens: int | None = None,
        request_timeout: float | None = None,
    ) -> ChatResult:
        if self._totals.llm_calls >= self._limit:
            raise AgentFailure("step_limit", f"more than {self._limit} model calls in one run")
        self._totals.llm_calls += 1
        if model not in self._totals.models:
            self._totals.models.append(model)
        result = await self._inner.complete(
            messages,
            model=model,
            json_mode=json_mode,
            max_tokens=max_tokens,
            request_timeout=request_timeout or self._timeout,
        )
        self._totals.input_tokens += result.input_tokens
        self._totals.output_tokens += result.output_tokens
        return result


def _ctx(config: RunnableConfig) -> RunContext:
    ctx: RunContext = config["configurable"]["ctx"]
    return ctx


def excerpt_block(chunks: Sequence[Candidate]) -> str:
    parts = []
    for number, c in enumerate(chunks, start=1):
        where = " > ".join(c.heading_path)
        header = f"[{number}] {c.doc_code} v{c.version} ({c.status}) - {c.title}"
        parts.append(f"{header}{' - ' + where if where else ''}\n{c.text}")
    return "\n\n".join(parts)


def citation_info(number: int, c: Candidate) -> dict[str, Any]:
    return {
        "n": number,
        "doc_code": c.doc_code,
        "title": c.title,
        "version": c.version,
        "status": c.status,
        "heading_path": c.heading_path,
        "page": c.page,
        "chunk_id": str(c.chunk_id),
        "document_id": str(c.document_id),
        "kind": "document",
    }


class AgentNodes:
    def __init__(
        self,
        *,
        engine: AsyncEngine,
        settings: Settings,
        embedder: EmbeddingClient,
        retrieve_fn: RetrieveFn = retrieve,
    ) -> None:
        self._engine = engine
        self._settings = settings
        self._embedder = embedder
        self._retrieve = retrieve_fn

    # --- context and input checks ----------------------------------------------------------

    async def load_context(self, state: AgentState, config: RunnableConfig) -> AgentState:
        ctx = _ctx(config)
        async with self._engine.connect() as conn:
            row = (
                (
                    await conn.execute(
                        text(
                            "SELECT session_mode, pending_question, clarify_count "
                            "FROM ai.conversations WHERE id = :c"
                        ),
                        {"c": ctx.conversation_id},
                    )
                )
                .mappings()
                .one()
            )
            history = await recent_turns(
                conn, ctx.conversation_id, self._settings.agent_history_turns
            )
        return {
            "history": history,
            "session_mode": row["session_mode"],
            "pending_question": row["pending_question"],
            "clarify_count": row["clarify_count"],
            "retrieval_attempts": 0,
            "verify_attempts": 0,
            "route": "guard_input",
        }

    async def guard_input(self, state: AgentState, config: RunnableConfig) -> AgentState:
        text_in = state["user_text"].strip()
        if (
            not text_in
            or len(text_in) > self._settings.agent_max_input_chars
            or _INJECTION.search(text_in)
        ):
            return {"route": "end_refused", "end_reason": "input_blocked"}
        return {"route": "understand"}

    # --- understanding ---------------------------------------------------------------------

    async def understand(self, state: AgentState, config: RunnableConfig) -> AgentState:
        ctx = _ctx(config)
        lines = [f"{m['role']}: {m['content']}" for m in state.get("history", [])]
        user = "Conversation so far:\n" + ("\n".join(lines) or "(none)")
        if state.get("session_mode") == "need_clarification" and state.get("pending_question"):
            user += f"\n\nPending question awaiting clarification: {state['pending_question']}"
        user += f"\n\nLatest message: {state['user_text']}"
        try:
            result = await ctx.chat.complete(
                [
                    {"role": "system", "content": prompt_text("understand")},
                    {"role": "user", "content": user},
                ],
                model=self._settings.model_understand,
                json_mode=True,
            )
        except ChatError as exc:
            raise AgentFailure("llm_error", str(exc)) from exc
        try:
            data = parse_json_object(result.text)
        except ChatError:
            # An unreadable answer is not an outage: search with the message as written.
            logger.warning("understand returned unreadable JSON; falling back to the raw message")
            data = {}
        intent = str(data["intent"]) if data.get("intent") in INTENTS else "doc_qa"
        query = str(data.get("standalone_query") or "").strip() or state["user_text"].strip()
        update: AgentState = {"intent": intent, "standalone_query": query}

        if bool(data.get("needs_clarification")) and intent == "doc_qa":
            question = str(data.get("clarification_question") or "").strip()
            if state.get("clarify_count", 0) >= self._settings.agent_max_clarifications:
                return {**update, "route": "end_not_found", "end_reason": "clarification_limit"}
            return {
                **update,
                "clarification_question": question or messages.CLARIFICATION_FALLBACK,
                "route": "end_need_clarification",
            }
        if intent == "out_of_scope":
            return {**update, "route": "end_refused", "end_reason": "out_of_scope"}
        if intent == "action":
            return {**update, "route": "end_refused", "end_reason": "write_not_enabled"}
        if intent == "data_query":
            return {**update, "route": "plan_data_access"}
        if intent == "chitchat":
            return {**update, "route": "chitchat_reply"}
        return {**update, "route": "retrieve_docs"}

    async def chitchat_reply(self, state: AgentState, config: RunnableConfig) -> AgentState:
        return {
            "reply": messages.CHITCHAT,
            "answer": messages.CHITCHAT,
            "citations": [],
            "route": "end_answered",
        }

    # --- retrieval -------------------------------------------------------------------------

    async def retrieve_docs(self, state: AgentState, config: RunnableConfig) -> AgentState:
        ctx = _ctx(config)
        try:
            async with self._engine.connect() as conn:
                found = await self._retrieve(
                    conn,
                    ctx.identity,
                    state["standalone_query"],
                    mode=self._settings.retrieval_mode,
                    settings=self._settings,
                    embedder=self._embedder,
                    reranker=ctx.reranker,
                    probe=True,
                )
        except AgentFailure:
            raise
        except Exception as exc:
            raise AgentFailure("retrieval_error", f"{type(exc).__name__}: {exc}") from exc
        diagnostics = found.diagnostics
        top = found.chunks[0].rerank_score if found.chunks else None
        restricted = (
            diagnostics.restricted_keyword_hits > 0
            and (diagnostics.restricted_best_keyword_score or 0.0)
            >= self._settings.grade_restricted_min_keyword_score
        )
        totals = ctx.totals
        totals.restricted_keyword_hits = max(
            totals.restricted_keyword_hits, diagnostics.restricted_keyword_hits
        )
        totals.rerank_failed = totals.rerank_failed or diagnostics.rerank_failed
        for chunk in found.chunks:
            if str(chunk.document_id) not in totals.document_ids:
                totals.document_ids.append(str(chunk.document_id))
        return {
            "chunks": found.chunks,
            "top_rerank_score": top,
            "restricted": restricted,
            "retrieval_attempts": state.get("retrieval_attempts", 0) + 1,
            "route": "grade_retrieval",
        }

    async def grade_retrieval(self, state: AgentState, config: RunnableConfig) -> AgentState:
        chunks = state.get("chunks", [])
        top = state.get("top_rerank_score")
        # No rerank score (reranking off or failed): the answer step makes the decision.
        enough = bool(chunks) and (top is None or top >= self._settings.grade_min_rerank_score)
        if enough:
            return {"route": "generate"}
        if state.get("restricted"):
            # Retrying cannot help: the content that matches is content this user may not read.
            return {"route": "end_no_permission", "end_reason": "restricted_document"}
        if state.get("retrieval_attempts", 0) <= self._settings.agent_retrieval_retries:
            return {"route": "rewrite_query"}
        return {"route": "end_not_found", "end_reason": "no_relevant_documents"}

    async def rewrite_query(self, state: AgentState, config: RunnableConfig) -> AgentState:
        ctx = _ctx(config)
        try:
            result = await ctx.chat.complete(
                [
                    {"role": "system", "content": prompt_text("rewrite")},
                    {"role": "user", "content": state["standalone_query"]},
                ],
                model=self._settings.model_understand,
                json_mode=True,
            )
        except ChatError as exc:
            raise AgentFailure("llm_error", str(exc)) from exc
        try:
            rewritten = str(parse_json_object(result.text).get("query") or "").strip()
        except ChatError:
            rewritten = ""
        return {
            "standalone_query": rewritten or state["standalone_query"],
            "route": "retrieve_docs",
        }

    # --- the answer ------------------------------------------------------------------------

    async def generate(self, state: AgentState, config: RunnableConfig) -> AgentState:
        ctx = _ctx(config)
        chunks = state["chunks"]
        question = state["standalone_query"]
        if state["user_text"].strip() != question:
            question += f"\n(The user's own words: {state['user_text'].strip()})"
        user = f"Question: {question}\n\nExcerpts:\n\n{excerpt_block(chunks)}"
        if state.get("verify_feedback"):
            user += f"\n\nYour previous reply was rejected: {state['verify_feedback']} Reply again."
        try:
            result = await ctx.chat.complete(
                [
                    {"role": "system", "content": prompt_text("generate")},
                    {"role": "user", "content": user},
                ],
                model=self._settings.model_generate,
                json_mode=True,
            )
        except ChatError as exc:
            raise AgentFailure("llm_error", str(exc)) from exc
        try:
            data = parse_json_object(result.text)
        except ChatError as exc:
            return {"generation_ok": False, "verify_feedback": str(exc), "route": "verify_answer"}
        cited = [
            n for n in data.get("citations", []) if isinstance(n, int) and not isinstance(n, bool)
        ]
        return {
            "generation_ok": True,
            "sufficient": bool(data.get("sufficient")),
            "answer": str(data.get("answer") or "").strip(),
            "cited": cited,
            "route": "verify_answer",
        }

    async def verify_answer(self, state: AgentState, config: RunnableConfig) -> AgentState:
        attempts = state.get("verify_attempts", 0) + 1
        problem = self._problem(state)
        if problem is None:
            if not state["sufficient"]:
                return {
                    "route": "end_not_found",
                    "end_reason": "no_relevant_documents",
                    "verify_attempts": attempts,
                }
            chunks = state["chunks"]
            numbers = sorted(
                set(_CITATION.findall(state["answer"])) | {str(n) for n in state["cited"]}, key=int
            )
            citations = [citation_info(int(n), chunks[int(n) - 1]) for n in numbers]
            return {"citations": citations, "route": "end_answered", "verify_attempts": attempts}
        if attempts <= self._settings.agent_verify_retries:
            return {"verify_feedback": problem, "route": "generate", "verify_attempts": attempts}
        return {"route": "end_error", "end_reason": "llm_error", "verify_attempts": attempts}

    def _problem(self, state: AgentState) -> str | None:
        """Why the answer cannot be used, or None when it can."""
        if not state.get("generation_ok", False):
            return state.get("verify_feedback") or "the reply was not valid JSON."
        if not state["sufficient"]:
            return None
        answer = state["answer"]
        available = set(range(1, len(state["chunks"]) + 1))
        used = {int(n) for n in _CITATION.findall(answer)}
        if not answer:
            return "the answer was empty."
        if len(answer) > MAX_ANSWER_CHARS:
            return f"the answer was longer than {MAX_ANSWER_CHARS} characters."
        if not used:
            return "the answer cites no excerpt; put [n] after each fact."
        if not used <= available or not set(state["cited"]) <= available:
            return (
                "it cites an excerpt that does not exist; "
                f"the excerpts are numbered 1 to {len(available)}."
            )
        return None

    # --- business data ---------------------------------------------------------------------

    async def plan_data_access(self, state: AgentState, config: RunnableConfig) -> AgentState:
        ctx = _ctx(config)
        try:
            result = await ctx.chat.complete(
                [
                    {"role": "system", "content": prompt_text("plan_data")},
                    {"role": "user", "content": state["standalone_query"]},
                ],
                model=self._settings.model_plan,
                json_mode=True,
            )
        except ChatError as exc:
            raise AgentFailure("llm_error", str(exc)) from exc
        try:
            data = parse_json_object(result.text)
        except ChatError:
            data = {}
        arguments = data.get("arguments")
        if (
            data.get("path") == "tool"
            and data.get("tool") in PLANNED_TOOLS
            and isinstance(arguments, dict)
            and ctx.data_tools is not None
        ):
            return {
                "plan_path": "tool",
                "tool_name": str(data["tool"]),
                "tool_args": arguments,
                "route": "call_data_tool",
            }
        return {"plan_path": "sql", "sql_attempts": 0, "route": "run_sql"}

    async def call_data_tool(self, state: AgentState, config: RunnableConfig) -> AgentState:
        ctx = _ctx(config)
        outcome = await ctx.data_tools.call(
            ctx.identity, state["tool_name"], state["tool_args"], token=ctx.access_token
        )
        if outcome.get("ok"):
            payload = {k: v for k, v in outcome.items() if k not in ("ok", "row_count", "views")}
            return {
                "data_rows": [payload],
                "data_row_count": int(outcome.get("row_count") or 1),
                "data_views": list(outcome.get("views", [])),
                "route": "answer_from_data",
            }
        code = outcome.get("error", {}).get("code")
        if code == "forbidden":
            return {"route": "end_no_permission", "end_reason": "restricted_data"}
        if code == "not_found":
            return {"route": "end_not_found", "end_reason": "no_matching_rows"}
        if code == "invalid_argument":
            # The planner's arguments were wrong: let the SQL path try the question itself.
            return {"plan_path": "sql", "sql_attempts": 0, "route": "run_sql"}
        raise AgentFailure("tool_error", str(outcome.get("error")))

    async def _policy_excerpts(self, state: AgentState, ctx: RunContext) -> str:
        if state.get("policy_excerpts") is not None:
            return state["policy_excerpts"]
        try:
            async with self._engine.connect() as conn:
                found = await self._retrieve(
                    conn,
                    ctx.identity,
                    state["standalone_query"],
                    mode="hybrid",
                    settings=self._settings,
                    embedder=self._embedder,
                )
        except Exception:
            logger.exception("policy excerpts for the SQL step could not be fetched")
            return ""
        chunks = found.chunks[:POLICY_EXCERPTS]
        for chunk in chunks:
            if str(chunk.document_id) not in ctx.totals.document_ids:
                ctx.totals.document_ids.append(str(chunk.document_id))
        return excerpt_block(chunks)

    async def run_sql(self, state: AgentState, config: RunnableConfig) -> AgentState:
        ctx = _ctx(config)
        attempts = state.get("sql_attempts", 0)
        excerpts = await self._policy_excerpts(state, ctx)
        user = f"{schema_prompt(ctx.identity)}\n\nQuestion: {state['standalone_query']}"
        if excerpts:
            user += f"\n\nPolicy excerpts:\n\n{excerpts}"
        if state.get("sql_feedback"):
            user += f"\n\nYour previous query failed: {state['sql_feedback']} Write a new one."
        try:
            result = await ctx.chat.complete(
                [
                    {"role": "system", "content": prompt_text("sql")},
                    {"role": "user", "content": user},
                ],
                model=self._settings.model_sql,
                json_mode=True,
            )
        except ChatError as exc:
            raise AgentFailure("llm_error", str(exc)) from exc
        try:
            written = str(parse_json_object(result.text).get("sql") or "")
        except ChatError:
            written = ""
        retry = {"policy_excerpts": excerpts, "sql_attempts": attempts + 1, "route": "run_sql"}
        give_up: AgentState = {"route": "end_error", "end_reason": "sql_failed"}

        def failed(feedback: str) -> AgentState:
            if attempts >= self._settings.agent_max_sql_retries:
                ctx.totals.failure_detail = f"sql: {feedback}"
                return give_up
            return {**retry, "sql_feedback": feedback}  # type: ignore[typeddict-item]

        try:
            checked = validate_sql(written, ctx.identity)
        except AccessDenied:
            return {"route": "end_no_permission", "end_reason": "restricted_data"}
        except SqlRejected as rejected:
            return failed(rejected.message)
        try:
            async with self._engine.begin() as conn:
                rows = await run_as_identity(
                    conn,
                    ctx.identity,
                    checked.sql,
                    max_rows=self._settings.data_max_rows,
                    timeout_ms=self._settings.data_statement_timeout_ms,
                )
        except Exception as exc:
            return failed(f"the database rejected it: {str(exc).splitlines()[0][:200]}")
        if not rows:
            return {"route": "end_not_found", "end_reason": "no_matching_rows"}
        return {
            "data_rows": rows,
            "data_row_count": len(rows),
            "data_views": list(checked.views),
            "data_sql": checked.sql,
            "route": "answer_from_data",
        }

    async def answer_from_data(self, state: AgentState, config: RunnableConfig) -> AgentState:
        ctx = _ctx(config)
        rows = state["data_rows"][: self._settings.data_rows_to_model]
        payload = json.dumps(
            {"rows_total": state["data_row_count"], "rows": rows}, default=str, ensure_ascii=False
        )
        try:
            result = await ctx.chat.complete(
                [
                    {"role": "system", "content": prompt_text("answer_data")},
                    {
                        "role": "user",
                        "content": f"Question: {state['standalone_query']}\n\nData:\n{payload}",
                    },
                ],
                model=self._settings.model_generate,
                json_mode=True,
            )
        except ChatError as exc:
            raise AgentFailure("llm_error", str(exc)) from exc
        try:
            answer = str(parse_json_object(result.text).get("answer") or "").strip()
        except ChatError as exc:
            raise AgentFailure("llm_error", str(exc)) from exc
        if not answer or len(answer) > MAX_ANSWER_CHARS:
            raise AgentFailure("llm_error", "the data answer was empty or too long")
        if "[1]" not in answer:
            answer += " [1]"
        citation = {
            "n": 1,
            "kind": "data",
            "views": state["data_views"],
            "row_count": state["data_row_count"],
        }
        return {"answer": answer, "citations": [citation], "route": "end_answered"}

    # --- the six ways a run can end --------------------------------------------------------

    async def end_answered(self, state: AgentState, config: RunnableConfig) -> AgentState:
        return {"end_state": "answered", "end_reason": None, "reply": state["answer"]}

    async def end_need_clarification(self, state: AgentState, config: RunnableConfig) -> AgentState:
        return {
            "end_state": "need_clarification",
            "end_reason": "ambiguous_question",
            "reply": state["clarification_question"],
        }

    async def end_no_permission(self, state: AgentState, config: RunnableConfig) -> AgentState:
        return {
            "end_state": "no_permission",
            "end_reason": state.get("end_reason") or "restricted_document",
            "reply": (
                messages.NO_MATCHING_ROWS
                if state.get("end_reason") == "restricted_data"
                else messages.NOT_FOUND
            ),
        }

    async def end_not_found(self, state: AgentState, config: RunnableConfig) -> AgentState:
        reason = state.get("end_reason") or "no_relevant_documents"
        reply = {
            "clarification_limit": messages.CLARIFICATION_LIMIT,
            "no_matching_rows": messages.NO_MATCHING_ROWS,
        }.get(reason, messages.NOT_FOUND)
        return {"end_state": "not_found", "end_reason": reason, "reply": reply}

    async def end_refused(self, state: AgentState, config: RunnableConfig) -> AgentState:
        reason = state.get("end_reason") or "out_of_scope"
        return {
            "end_state": "refused",
            "end_reason": reason,
            "reply": messages.REFUSED.get(reason, messages.REFUSED["out_of_scope"]),
        }

    async def end_error(self, state: AgentState, config: RunnableConfig) -> AgentState:
        ctx = _ctx(config)
        return {
            "end_state": "error",
            "end_reason": state.get("end_reason") or "internal",
            "reply": messages.ERROR.format(run_id=ctx.run_id),
        }


PROMPTS_USED = PROMPT_VERSIONS
