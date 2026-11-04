"""The ingestion job queue, kept in Postgres (ai.ingestion_jobs).

A worker claims a job with FOR UPDATE SKIP LOCKED, so several workers can run at once and
each job is taken by exactly one of them. A failed job is queued again with a growing delay
until it has used its attempts; then it is marked failed and the document is marked failed.
"""

import json
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from starit_core.ingest.errors import IngestError

BACKOFF_SECONDS = (30, 120, 600)  # delay after the 1st, 2nd, 3rd... failed attempt


@dataclass(frozen=True)
class Job:
    id: UUID
    document_id: UUID
    attempt: int
    max_attempts: int
    config: dict[str, Any]


async def enqueue(
    conn: AsyncConnection, document_id: UUID, config: dict[str, Any] | None = None
) -> UUID:
    """Queue a document for ingestion, unless a job for it is already waiting or running."""
    existing = (
        await conn.execute(
            text(
                "SELECT id FROM ai.ingestion_jobs "
                "WHERE document_id = :d AND status IN ('queued', 'running') LIMIT 1"
            ),
            {"d": document_id},
        )
    ).scalar()
    if existing is not None:
        return UUID(str(existing))
    job_id = (
        await conn.execute(
            text(
                "INSERT INTO ai.ingestion_jobs (document_id, config) "
                "VALUES (:d, CAST(:c AS jsonb)) RETURNING id"
            ),
            {"d": document_id, "c": json.dumps(config or {})},
        )
    ).scalar_one()
    await conn.execute(
        text("UPDATE ai.documents SET ingest_status = 'queued' WHERE id = :d"), {"d": document_id}
    )
    return UUID(str(job_id))


async def count_queued(conn: AsyncConnection) -> int:
    return int(
        (
            await conn.execute(
                text("SELECT count(*) FROM ai.ingestion_jobs WHERE status = 'queued'")
            )
        ).scalar_one()
    )


async def claim_next(conn: AsyncConnection, worker_id: str) -> Job | None:
    row = (
        (
            await conn.execute(
                text(
                    """
                    UPDATE ai.ingestion_jobs
                    SET status = 'running', locked_by = :w, locked_at = now(),
                        attempt = attempt + 1, started_at = COALESCE(started_at, now())
                    WHERE id = (
                        SELECT id FROM ai.ingestion_jobs
                        WHERE status = 'queued' AND run_after <= now()
                        ORDER BY run_after, id
                        FOR UPDATE SKIP LOCKED
                        LIMIT 1
                    )
                    RETURNING id, document_id, attempt, max_attempts, config
                    """
                ),
                {"w": worker_id},
            )
        )
        .mappings()
        .first()
    )
    if row is None:
        return None
    await conn.execute(
        text("UPDATE ai.documents SET ingest_status = 'running' WHERE id = :d"),
        {"d": row["document_id"]},
    )
    return Job(
        id=UUID(str(row["id"])),
        document_id=UUID(str(row["document_id"])),
        attempt=row["attempt"],
        max_attempts=row["max_attempts"],
        config=dict(row["config"] or {}),
    )


async def mark_stage(conn: AsyncConnection, job_id: UUID, stage: str) -> None:
    await conn.execute(
        text("UPDATE ai.ingestion_jobs SET stage = :s WHERE id = :j"), {"s": stage, "j": job_id}
    )


async def mark_succeeded(conn: AsyncConnection, job: Job) -> None:
    await conn.execute(
        text(
            "UPDATE ai.ingestion_jobs SET status = 'succeeded', finished_at = now(), "
            "locked_by = NULL, error_code = NULL, error_message = NULL WHERE id = :j"
        ),
        {"j": job.id},
    )
    await conn.execute(
        text("UPDATE ai.documents SET ingest_status = 'ready', updated_at = now() WHERE id = :d"),
        {"d": job.document_id},
    )


async def mark_failed(conn: AsyncConnection, job: Job, error: IngestError) -> bool:
    """Record a failure. Returns True when the job was queued again, False when it gave up."""
    retry = error.retryable and job.attempt < job.max_attempts
    params = {
        "j": job.id,
        "stage": error.stage,
        "code": error.code,
        "message": error.message[:2000],
    }
    if retry:
        delay = BACKOFF_SECONDS[min(job.attempt, len(BACKOFF_SECONDS)) - 1]
        await conn.execute(
            text(
                "UPDATE ai.ingestion_jobs SET status = 'queued', locked_by = NULL, stage = :stage, "
                "error_code = :code, error_message = :message, "
                "run_after = now() + make_interval(secs => :delay) WHERE id = :j"
            ),
            {**params, "delay": delay},
        )
        await conn.execute(
            text("UPDATE ai.documents SET ingest_status = 'queued' WHERE id = :d"),
            {"d": job.document_id},
        )
        return True
    await conn.execute(
        text(
            "UPDATE ai.ingestion_jobs SET status = 'failed', finished_at = now(), "
            "locked_by = NULL, stage = :stage, error_code = :code, error_message = :message "
            "WHERE id = :j"
        ),
        params,
    )
    await conn.execute(
        text("UPDATE ai.documents SET ingest_status = 'failed', updated_at = now() WHERE id = :d"),
        {"d": job.document_id},
    )
    return False


async def requeue_stale(conn: AsyncConnection, older_than_seconds: int) -> int:
    """Put back jobs whose worker stopped without finishing (it died or was killed)."""
    result = await conn.execute(
        text(
            "UPDATE ai.ingestion_jobs SET status = 'queued', locked_by = NULL "
            "WHERE status = 'running' AND locked_at < now() - make_interval(secs => :s)"
        ),
        {"s": older_than_seconds},
    )
    return int(result.rowcount)
