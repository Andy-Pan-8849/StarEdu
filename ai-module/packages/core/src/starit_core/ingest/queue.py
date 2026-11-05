"""文件：ingest/queue.py
作用：入库任务队列，直接用 Postgres 表 ai.ingestion_jobs 实现（不额外引入消息队列）。
主要思想：
  - 领取任务用 `FOR UPDATE SKIP LOCKED`：多个 worker 同时跑也不会领到同一个任务，
    也不会互相阻塞。
  - 失败后按退避时间(30 秒、2 分钟、10 分钟…)重新排队；用完次数则任务标记失败，文档也标记失败。
  - worker 异常退出时，卡在 running 的任务超时后被放回队列（requeue_stale）。
"""

import json
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from starit_core.ingest.errors import IngestError

# 第 1、2、3… 次失败后各等多少秒再重试
BACKOFF_SECONDS = (30, 120, 600)  # delay after the 1st, 2nd, 3rd... failed attempt


@dataclass(frozen=True)
class Job:
    """一个被领取的入库任务：任务 ID、文档 ID、第几次尝试、最多几次、配置。"""

    id: UUID
    document_id: UUID
    attempt: int
    max_attempts: int
    config: dict[str, Any]


async def enqueue(
    conn: AsyncConnection, document_id: UUID, config: dict[str, Any] | None = None
) -> UUID:
    """给文档排一个入库任务；若已有排队中或运行中的任务就不重复排，直接返回它的 ID。
    参数：document_id 文档；config 任务配置（如是否生成衍生内容）。
    """
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
    """排队中的任务数（用于队列长度指标）。"""
    return int(
        (
            await conn.execute(
                text("SELECT count(*) FROM ai.ingestion_jobs WHERE status = 'queued'")
            )
        ).scalar_one()
    )


async def claim_next(conn: AsyncConnection, worker_id: str) -> Job | None:
    """领取下一个到期的任务，没有则返回 None。

    在一条 UPDATE 里完成“选中 + 标记为运行中 + 尝试次数加一”，选中时加 SKIP LOCKED，
    所以并发领取是安全的。同时把文档状态改为 running。
    """
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
    """记录任务当前所处阶段（解析/切块/嵌入…），方便在管理页看进度和失败位置。"""
    await conn.execute(
        text("UPDATE ai.ingestion_jobs SET stage = :s WHERE id = :j"), {"s": stage, "j": job_id}
    )


async def mark_succeeded(conn: AsyncConnection, job: Job) -> None:
    """任务成功：任务置 succeeded，文档置 ready。"""
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
    """记录一次失败。

    可重试且还有次数：按退避时间重新排队，返回 True；否则任务和文档都标记为 failed，返回 False。
    """
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
    """把超过 older_than_seconds 秒仍在运行的任务放回队列（worker 可能已崩溃）。返回放回了几个。"""
    result = await conn.execute(
        text(
            "UPDATE ai.ingestion_jobs SET status = 'queued', locked_by = NULL "
            "WHERE status = 'running' AND locked_at < now() - make_interval(secs => :s)"
        ),
        {"s": older_than_seconds},
    )
    return int(result.rowcount)
