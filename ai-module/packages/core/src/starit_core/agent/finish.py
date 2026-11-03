"""Record a run: one transaction writes the run, both messages, the audit entry and the
conversation's new state, so a failure never leaves half of it."""

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
    """Returns the id of the assistant message."""
    end_state = final["end_state"]
    message_id = uuid4()
    async with engine.begin() as conn:
        await conn.execute(
            text(
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
                "INSERT INTO ai.messages (conversation_id, run_id, role, content, created_at) "
                "VALUES (:c, :r, 'user', :content, :at)"
            ),
            {"c": conversation_id, "r": run_id, "content": user_text, "at": started_at},
        )
        await conn.execute(
            text(
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
        await _update_conversation(conn, conversation_id, user_text, final)
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
        "failure": totals.failure_detail,
    }
