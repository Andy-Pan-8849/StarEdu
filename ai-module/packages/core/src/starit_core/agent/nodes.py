"""文件：agent/nodes.py
作用：助手流程图里每一个“步骤”的实现。每个步骤接收当前状态，返回要改动的字段
（包括 `route`——下一步去哪）。步骤之间怎么连见 graph.py。
主要内容（按流程顺序）：
  - 上下文与输入检查：load_context、guard_input
  - 理解：understand（判断意图、把问题改写成独立问题、必要时只反问一次）、chitchat_reply
  - 文档检索：retrieve_docs、grade_retrieval（够不够好）、rewrite_query（重写再试）
  - 作答：generate（生成并引用）、verify_answer（对照原文校验，失败重试）
  - 业务数据：plan_data_access（选工具还是写 SQL）、call_data_tool、run_sql、answer_from_data
  - 六个结局：end_answered / need_clarification / no_permission / not_found / refused / error
  - BudgetedChat：包住聊天客户端，统计调用次数、token、费用，并限制每次运行的调用上限。
主要思想：权限由数据库层面保证（检索和 SQL 都按提问者身份过滤），模型只会看到用户有权读的内容；
“没找到”和“没权限”对用户说同一句话，避免泄露受限内容的存在。
"""

import json
import logging
import re
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any

from langchain_core.runnables import RunnableConfig
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from starit_core import telemetry
from starit_core.agent import messages
from starit_core.agent.prompts import PROMPT_VERSIONS, prompt_text
from starit_core.agent.state import AgentState, RunContext
from starit_core.config import Settings
from starit_core.conversations import recent_turns
from starit_core.cost import DailyBudget, call_cost_usd
from starit_core.dataaccess.schema import schema_prompt
from starit_core.dataaccess.sqlguard import AccessDenied, SqlRejected, validate_sql
from starit_core.embeddings import EmbeddingClient
from starit_core.llm import ChatClient, ChatError, ChatResult, parse_json_object
from starit_core.retrieval import RetrievalResult, retrieve
from starit_core.retrieval.models import Candidate
from starit_core.sqlaccess import run_as_identity
from starit_core.streaming import AnswerStream

logger = logging.getLogger("starit.agent")

# 规划器允许选择的数据工具（白名单，其余一律走 SQL 路径）
PLANNED_TOOLS = (
    "list_assignments",
    "list_students",
    "get_student_progress",
    "get_expense_claim_status",
    "list_my_expense_claims",
)
# 写 SQL 时附带给模型的相关政策摘录最多几段
POLICY_EXCERPTS = 3
# understand 步骤允许模型返回的意图；其余值按 doc_qa 处理
INTENTS = ("doc_qa", "data_query", "action", "chitchat", "out_of_scope")
# 回答的最大长度，超过视为不合格
MAX_ANSWER_CHARS = 4000
# 匹配回答里的引用标记，如 [1]
_CITATION = re.compile(r"\[(\d+)\]")
# Only the plainest attempts; the real protection is that the model is never given anything the
# user may not read.
_INJECTION = re.compile(
    r"ignore (all |any )?(the )?(previous|prior|above) (instructions|rules|prompts?)"
    r"|disregard (your|the) (instructions|rules|system prompt)"
    r"|(reveal|show|print|repeat) (me )?(your|the) (system )?(prompt|instructions)",
    re.IGNORECASE,
)

# 检索函数的类型；测试里可以替换成假的
RetrieveFn = Callable[..., Awaitable[RetrievalResult]]


class AgentFailure(Exception):
    """步骤以可预期的方式失败，运行以 error 结局结束。reason 是简短原因码，detail 是排查细节。"""

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(detail or reason)
        self.reason = reason
        self.detail = detail


def _same_model(answered: str, requested: str) -> bool:
    """`gpt-4o-mini-2024-07-18` answered a request for `openai/gpt-4o-mini`: the same model."""
    name = requested.split("/")[-1]
    return answered.startswith(name) or name.startswith(answered.split("/")[-1])


class BudgetedChat:
    """包住聊天客户端，为一次运行服务：
    1. 统计模型调用次数、token、费用和用到的模型；
    2. 限制每次运行的最多调用数（防止流程陷入循环烧钱）；
    3. 记录链路 span 和指标，发现“备用模型作答”（fallback）；
    4. 把费用累加到每日预算。
    """

    def __init__(
        self,
        inner: ChatClient,
        ctx_totals: Any,
        limit: int,
        request_timeout: float,
        budget: DailyBudget | None = None,
    ) -> None:
        self._inner = inner
        self._totals = ctx_totals
        self._limit = limit
        self._timeout = request_timeout
        self._budget = budget

    async def complete(
        self,
        messages: Sequence[Mapping[str, str]],
        *,
        model: str,
        json_mode: bool = False,
        max_tokens: int | None = None,
        request_timeout: float | None = None,
    ) -> ChatResult:
        return await self._invoke(
            messages,
            model,
            lambda: self._inner.complete(
                messages,
                model=model,
                json_mode=json_mode,
                max_tokens=max_tokens,
                request_timeout=request_timeout or self._timeout,
            ),
        )

    async def stream(
        self,
        messages: Sequence[Mapping[str, str]],
        *,
        model: str,
        json_mode: bool = False,
        max_tokens: int | None = None,
        request_timeout: float | None = None,
        on_chunk: Callable[[str], Awaitable[None]],
    ) -> ChatResult:
        """与 complete 相同，但每收到一段文字就调用 on_chunk。
        客户端不支持流式时一次性给完整文字，调用方不用关心差别。
        """
        inner_stream = getattr(self._inner, "stream", None)
        first = [True]
        started = time.perf_counter()

        async def seen(chunk: str) -> None:
            if first[0]:
                first[0] = False
                telemetry.current().llm_first_token.record(
                    time.perf_counter() - started, {"model": model}
                )
            await on_chunk(chunk)

        if inner_stream is None:

            async def whole() -> ChatResult:
                result: ChatResult = await self._inner.complete(
                    messages,
                    model=model,
                    json_mode=json_mode,
                    max_tokens=max_tokens,
                    request_timeout=request_timeout or self._timeout,
                )
                await seen(result.text)
                return result

            return await self._invoke(messages, model, whole)
        return await self._invoke(
            messages,
            model,
            lambda: inner_stream(
                messages,
                model=model,
                json_mode=json_mode,
                max_tokens=max_tokens,
                request_timeout=request_timeout or self._timeout,
                on_chunk=seen,
            ),
        )

    async def _invoke(
        self,
        messages: Sequence[Mapping[str, str]],
        model: str,
        call: Callable[[], Awaitable[ChatResult]],
    ) -> ChatResult:
        """所有模型调用的统一入口：检查上限、计数、开 span、计费、记录指标。

        参数：messages 发送的消息；model 请求的模型；call 真正发起调用的函数。
        返回：模型结果。超过调用上限抛 AgentFailure("step_limit")。
        """
        # 先检查本次运行的调用上限
        if self._totals.llm_calls >= self._limit:
            raise AgentFailure("step_limit", f"more than {self._limit} model calls in one run")
        self._totals.llm_calls += 1
        if model not in self._totals.models:
            self._totals.models.append(model)
        tele = telemetry.current()
        started = time.perf_counter()
        outcome = "error"
        with telemetry.span(
            "llm.chat",
            {"gen_ai.request.model": model, "langfuse.observation.type": "generation"},
        ) as active:
            if tele.capture_content:
                active.set_attribute(
                    "langfuse.observation.input", telemetry.clip(json.dumps(list(messages)))
                )
            try:
                result = await call()
                outcome = "ok"
            finally:
                tele.llm_calls.add(1, {"model": model, "outcome": outcome})
                tele.llm_duration.record(time.perf_counter() - started, {"model": model})
            active.set_attribute("gen_ai.usage.input_tokens", result.input_tokens)
            active.set_attribute("gen_ai.usage.output_tokens", result.output_tokens)
            answered_by = result.model or model
            active.set_attribute("gen_ai.response.model", answered_by)
            # 实际作答的模型与请求的不同 = 触发了备用链
            if result.model and not _same_model(result.model, model):
                active.set_attribute("llm.fallback", True)
                tele.llm_fallbacks.add(1, {"requested": model, "answered": result.model})
                self._totals.fallbacks += 1
                logger.warning("%s did not answer; %s did (fallback)", model, result.model)
            # 按实际作答的模型计费，并累加到整日预算
            cost = call_cost_usd(answered_by, result.input_tokens, result.output_tokens)
            self._totals.cost_usd += cost
            tele.llm_cost.add(cost, {"model": answered_by})
            if self._budget is not None:
                await self._budget.add(cost)
            if tele.capture_content:
                active.set_attribute("langfuse.observation.output", telemetry.clip(result.text))
        tele.llm_tokens.add(result.input_tokens, {"model": model, "direction": "input"})
        tele.llm_tokens.add(result.output_tokens, {"model": model, "direction": "output"})
        self._totals.input_tokens += result.input_tokens
        self._totals.output_tokens += result.output_tokens
        return result


def _ctx(config: RunnableConfig) -> RunContext:
    """从 LangGraph 的 config 里取出本次运行的上下文 RunContext。"""
    ctx: RunContext = config["configurable"]["ctx"]
    return ctx


def excerpt_block(chunks: Sequence[Candidate]) -> str:
    """把文本块排成带编号的摘录，放进提示词；模型回答里的 [n] 对应这里的编号。"""
    parts = []
    for number, c in enumerate(chunks, start=1):
        where = " > ".join(c.heading_path)
        header = f"[{number}] {c.doc_code} v{c.version} ({c.status}) - {c.title}"
        parts.append(f"{header}{' - ' + where if where else ''}\n{c.text}")
    return "\n\n".join(parts)


def citation_info(number: int, c: Candidate) -> dict[str, Any]:
    """生成返回给前端的引用信息（文档编号、版本、标题、章节路径、页码等）。"""
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
    """流程图的全部步骤。依赖（数据库、配置、嵌入客户端、检索函数）在构造时注入，便于测试。"""

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
        """读取会话状态（是否在等澄清）和最近几轮对话，并清零本次运行的重试计数。"""
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
        """输入检查：空消息、过长消息，或明显的提示词注入话术直接拒绝。
        这只是最浅的一层；真正的保护是模型永远拿不到用户无权读的内容。
        """
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
        """理解问题：让模型判断意图，并把问题（结合上下文）改写成可以独立检索的一句话。

        意图 -> 去向：doc_qa 去检索；data_query 去数据；chitchat 打招呼；
        action（写操作）和 out_of_scope 拒绝；含糊的文档类问题只反问一次（超过次数则当作没找到）。
        模型返回无法解析时不报错，直接用用户原话继续。
        """
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
        """闲聊：固定回复，介绍能回答哪些问题。"""
        return {
            "reply": messages.CHITCHAT,
            "answer": messages.CHITCHAT,
            "citations": [],
            "route": "end_answered",
        }

    # --- retrieval -------------------------------------------------------------------------

    async def retrieve_docs(self, state: AgentState, config: RunnableConfig) -> AgentState:
        """文档检索：按提问者身份检索，并顺便统计“被权限挡住的强相关内容”。

        restricted 的含义：有强相关的命中但用户无权读。它只用来决定“没权限”还是“没找到”，
        内容绝不会进入提示词。同时把读到的文档 ID 记入统计（写审计用）。
        """
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
        """判断检索结果够不够好：
        够 -> 去生成；不够且是因为有内容被权限挡住 -> 没权限（重试没用）；
        不够且还有重试次数 -> 改写问题再检索；否则 -> 没找到。
        """
        chunks = state.get("chunks", [])
        top = state.get("top_rerank_score")
        # No rerank score (reranking off or failed): the answer step makes the decision.
        # 没有重排分数（没开重排或重排失败）时不在这里判断，交给生成步骤决定
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
        """检索效果不好时，让模型换一种说法重写查询；模型失败则保留原查询。"""
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
        """生成回答：把带编号的摘录和问题交给模型，要求返回 JSON
        {"sufficient", "answer", "citations"}。sufficient 表示摘录足以回答。
        流式时回答文字边生成边发给客户端，但只在模型确认 sufficient 之后才放出（见 streaming.py）。
        若上一轮校验未通过，会把原因附在提示词里让模型重写。
        """
        ctx = _ctx(config)
        chunks = state["chunks"]
        question = state["standalone_query"]
        if state["user_text"].strip() != question:
            question += f"\n(The user's own words: {state['user_text'].strip()})"
        user = f"Question: {question}\n\nExcerpts:\n\n{excerpt_block(chunks)}"
        if state.get("verify_feedback"):
            user += f"\n\nYour previous reply was rejected: {state['verify_feedback']} Reply again."
        messages = [
            {"role": "system", "content": prompt_text("generate")},
            {"role": "user", "content": user},
        ]
        parser = AnswerStream(require_sufficient=True)
        try:
            result = await self._ask(ctx, messages, self._settings.model_generate, parser)
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

    async def _ask(
        self,
        ctx: RunContext,
        messages: list[dict[str, str]],
        model: str,
        parser: AnswerStream,
    ) -> ChatResult:
        """发起一次 JSON 模式的模型调用。

        有客户端在监听时，回答文字边写边通过 parser 筛选并转发；否则直接等完整结果。
        参数：ctx 运行上下文；messages 消息；model 模型名；parser 流式文字解析器。
        返回：模型结果。
        """
        emitter = ctx.emitter
        if emitter is None:
            plain: ChatResult = await ctx.chat.complete(messages, model=model, json_mode=True)
            return plain

        async def on_chunk(chunk: str) -> None:
            for piece in parser.feed(chunk):
                await emitter.delta(piece)

        streamed: ChatResult = await ctx.chat.stream(
            messages, model=model, json_mode=True, on_chunk=on_chunk
        )
        return streamed

    async def verify_answer(self, state: AgentState, config: RunnableConfig) -> AgentState:
        """校验回答（对照原文）：
        1. 校验通过且 sufficient -> 带引用结束；通过但 sufficient 为假 -> 没找到；
        2. 校验不通过 -> 撤回已流出的草稿（如果有），在重试次数内重新生成，否则出错。
        """
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
        if _ctx(config).emitter is not None:
            # The client may already be showing this draft: take it back before the next one.
            await _ctx(config).emitter.retract(problem)
        if attempts <= self._settings.agent_verify_retries:
            return {"verify_feedback": problem, "route": "generate", "verify_attempts": attempts}
        return {"route": "end_error", "end_reason": "llm_error", "verify_attempts": attempts}

    def _problem(self, state: AgentState) -> str | None:
        """回答不可用的原因，可用则返回 None。检查：JSON 是否有效、是否为空或过长、
        是否至少引用了一段摘录、引用的编号是否真实存在。
        """
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
        """规划数据访问：让模型在“固定工具”和“自己写 SQL”之间选。
        只有模型选了白名单里的工具、参数是字典、且工具客户端可用，才走工具；否则走 SQL。
        """
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
        """调用 MCP 数据工具（身份令牌随调用带上，权限由工具端再校验一次）。
        结果：成功 -> 据此作答；forbidden -> 没权限；not_found -> 没找到；
        参数错误 -> 退回 SQL 路径让它自己写；其余错误抛 AgentFailure。
        """
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
        """取少量相关政策摘录给 SQL 步骤参考（比如“超过酒店上限”要知道上限是多少）。
        同一次运行只取一次；取不到时静默返回空，不影响主流程。
        """
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
        """让模型写一条只读 SQL 并执行：
        1. 模型写 SQL（提示词里只有该用户能看到的视图结构）；
        2. validate_sql 校验：只允许白名单视图里的 SELECT；碰了无权的表 -> 没权限；
        3. 在事务内切换到只读角色并设置超时、行数上限后执行，视图按提问者身份过滤行；
        4. 校验或执行失败，把原因反馈给模型重写，超过重试次数则出错；没有行 -> 没找到。
        """
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

        # 失败处理：还有重试次数就带着反馈重写，否则以 sql_failed 结束
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
        """用查到的数据作答：只把前若干行（含总行数）交给模型，要求引用 [1]，
        引用信息里记录用了哪些视图、多少行。回答为空或过长视为失败。
        """
        ctx = _ctx(config)
        rows = state["data_rows"][: self._settings.data_rows_to_model]
        payload = json.dumps(
            {"rows_total": state["data_row_count"], "rows": rows}, default=str, ensure_ascii=False
        )
        messages = [
            {"role": "system", "content": prompt_text("answer_data")},
            {
                "role": "user",
                "content": f"Question: {state['standalone_query']}\n\nData:\n{payload}",
            },
        ]
        try:
            result = await self._ask(
                ctx,
                messages,
                self._settings.model_generate,
                AnswerStream(require_sufficient=False),
            )
        except ChatError as exc:
            raise AgentFailure("llm_error", str(exc)) from exc
        try:
            answer = str(parse_json_object(result.text).get("answer") or "").strip()
        except ChatError as exc:
            raise AgentFailure("llm_error", str(exc)) from exc
        if not answer or len(answer) > MAX_ANSWER_CHARS:
            raise AgentFailure("llm_error", "the data answer was empty or too long")
        # 数据类回答必须带引用，模型漏了就补上
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

    # —— 以下是六个结局：把结局和回复文字写入状态，由 runtime 统一落库
    async def end_answered(self, state: AgentState, config: RunnableConfig) -> AgentState:
        return {"end_state": "answered", "end_reason": None, "reply": state["answer"]}

    async def end_need_clarification(self, state: AgentState, config: RunnableConfig) -> AgentState:
        return {
            "end_state": "need_clarification",
            "end_reason": "ambiguous_question",
            "reply": state["clarification_question"],
        }

    async def end_no_permission(self, state: AgentState, config: RunnableConfig) -> AgentState:
        """无权限：对用户说的话与“没找到”完全相同，避免泄露受限内容的存在。
        end_reason 仍保留真实原因，供审计使用。
        """
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
        """出错：回复里带运行 ID，用户反馈时可据此在审计里查到详情。"""
        ctx = _ctx(config)
        return {
            "end_state": "error",
            "end_reason": state.get("end_reason") or "internal",
            "reply": messages.ERROR.format(run_id=ctx.run_id),
        }


PROMPTS_USED = PROMPT_VERSIONS
