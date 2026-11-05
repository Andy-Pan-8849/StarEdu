"""文件：agent/finish.py
作用：记录一次运行的结果。
主要思想：用同一个数据库事务写入运行记录、用户消息、助手消息、审计条目和会话的新状态，
任何一步失败都整体回滚，不会留下写了一半的记录。
"""

import json
import re
from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from starit_core.agent.prompts import PROMPT_VERSIONS
from starit_core.agent.state import AgentState, RunTotals
from starit_core.audit import write_audit
from starit_core.auth import Identity

TITLE_CHARS = 60


async def finish_run(
    engine: AsyncEngine,
    *,
    identity: Identity,
    conversation_id: UUID,
    run_id: UUID,
    user_text: str,
    started_at: datetime,
    final: AgentState,
    totals: RunTotals,
    latency_ms: int,
) -> UUID:
    """把一次运行落库。

    参数：
      engine：应用账号的数据库引擎；identity：提问者；conversation_id/run_id：会话与运行 ID。
      user_text：用户原文；started_at：运行开始时间；final：流程图的最终状态；
      totals：本次运行的统计；latency_ms：总耗时（毫秒）。
    返回：助手消息的 ID。
    """
    end_state = final["end_state"]
    message_id = uuid4()
    async with engine.begin() as conn:
        await conn.execute(
            text(
                # 1. 运行记录（结局、模型、token、耗时）
                "INSERT INTO ai.runs (id, conversation_id, user_id, started_at, ended_at, "
                "end_state, end_reason, model, tokens_in, tokens_out, latency_ms) "
                "VALUES (:id, :c, :u, :started, now(), :state, :reason, :model, :tin, :tout, :ms)"
            ),
            {
                "id": run_id,
                "c": conversation_id,
                "u": identity.user_id,
                "started": started_at,
                "state": end_state,
                "reason": final.get("end_reason"),
                "model": ", ".join(totals.models) or None,
                "tin": totals.input_tokens,
                "tout": totals.output_tokens,
                "ms": latency_ms,
            },
        )
        await conn.execute(
            text(
                # 2. 用户这条消息
                "INSERT INTO ai.messages (conversation_id, run_id, role, content, created_at) "
                "VALUES (:c, :r, 'user', :content, :at)"
            ),
            {"c": conversation_id, "r": run_id, "content": user_text, "at": started_at},
        )
        await conn.execute(
            text(
                # 3. 助手回复，含引用
                "INSERT INTO ai.messages (id, conversation_id, run_id, role, content, citations) "
                "VALUES (:id, :c, :r, 'assistant', :content, CAST(:citations AS jsonb))"
            ),
            {
                "id": message_id,
                "c": conversation_id,
                "r": run_id,
                "content": final["reply"],
                "citations": json.dumps(final.get("citations", [])),
            },
        )
        # 4. 更新会话状态（标题、是否在等用户澄清）
        await _update_conversation(conn, conversation_id, user_text, final)
        # 5. 只增不改的审计日志：谁、问了什么、读了哪些文档、被过滤了多少
        await write_audit(
            conn,
            action="chat.query",
            actor=identity,
            run_id=str(run_id),
            query_text=user_text,
            doc_ids=totals.document_ids,
            filtered_count=totals.restricted_keyword_hits,
            details=_details(final, totals),
        )
    return message_id


async def _update_conversation(
    conn: Any, conversation_id: UUID, user_text: str, final: AgentState
) -> None:
    """更新会话：标题取首条消息前 60 字；若本轮是反问，则记下待澄清的问题并计数，
    下一轮据此合并回答；正常结束则清除待澄清状态；出错则保持原状，免得丢掉正在等待的澄清。
    """
    title = re.sub(r"\s+", " ", user_text).strip()[:TITLE_CHARS]
    params: dict[str, Any] = {"c": conversation_id, "title": title}
    session = ""
    if final["end_state"] == "need_clarification":
        session = (
            ", session_mode = 'need_clarification', pending_question = :pending, "
            "clarify_count = clarify_count + 1"
        )
        params["pending"] = final.get("standalone_query") or user_text
    elif final["end_state"] != "error":
        # An error leaves the conversation as it was, so an awaited clarification is not lost.
        session = ", session_mode = 'answering', pending_question = NULL, clarify_count = 0"
    await conn.execute(
        text(
            "UPDATE ai.conversations SET updated_at = now(), "
            f"title = COALESCE(title, :title){session} WHERE id = :c"
        ),
        params,
    )


def _details(final: AgentState, totals: RunTotals) -> dict[str, Any]:
    """审计记录的详情：结局、意图、模型、token、费用、提示词版本、是否回退等。"""
    return {
        "end_state": final["end_state"],
        "end_reason": final.get("end_reason"),
        "intent": final.get("intent"),
        "models": totals.models,
        "llm_calls": totals.llm_calls,
        "input_tokens": totals.input_tokens,
        "output_tokens": totals.output_tokens,
        "retrieval_attempts": final.get("retrieval_attempts", 0),
        "rerank_failed": totals.rerank_failed,
        "prompt_versions": PROMPT_VERSIONS,
        "cost_usd": round(totals.cost_usd, 6),
        "fallbacks": totals.fallbacks,
        "failure": totals.failure_detail,
    }
