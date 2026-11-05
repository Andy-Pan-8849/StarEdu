"""文件：ingest/worker.py
作用：入库 worker 的主循环——不断从队列领任务并处理。
主要思想：先把卡住的任务放回队列，再领一个；没有任务就睡一会（worker_poll_seconds）；
每日预算用完时暂停取任务（任务留在队列里，预算在 UTC 零点重置后继续）。
once=True 时处理完现有任务就返回，用于脚本和测试。
"""

import asyncio
import logging
import os
import socket
from collections.abc import Awaitable, Callable

from sqlalchemy.ext.asyncio import AsyncEngine

from starit_core import telemetry
from starit_core.config import Settings
from starit_core.cost import DailyBudget
from starit_core.embeddings import EmbeddingClient
from starit_core.ingest import queue
from starit_core.ingest.pipeline import process_job
from starit_core.llm import ChatClient
from starit_core.storage import ObjectStorage

logger = logging.getLogger("starit.worker")


def default_worker_id() -> str:
    """本 worker 的标识：主机名:进程号，写在任务的 locked_by 里。"""
    return f"{socket.gethostname()}:{os.getpid()}"


async def run_worker(
    engine: AsyncEngine,
    storage: ObjectStorage,
    embedder: EmbeddingClient,
    settings: Settings,
    *,
    once: bool = False,
    worker_id: str | None = None,
    chat: ChatClient | None = None,
    budget: DailyBudget | None = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> int:
    """运行 worker。

    参数：engine 引擎；storage 对象存储；embedder 嵌入客户端；settings 配置；
      once 为真时没有就绪任务就返回；worker_id 标识；chat 衍生内容用的模型；
      budget 每日预算；sleep 等待函数（测试里可替换）。
    返回：处理的任务数。
    """
    worker_id = worker_id or default_worker_id()
    handled = 0
    while True:
        # 钱用完了：暂停取任务，任务留在队列里，重置后再处理
        if budget is not None and await budget.exhausted():
            # The day's money is spent: jobs stay queued and are taken after the reset.
            logger.warning("the daily budget is used up; ingestion is paused")
            if once:
                return handled
            await sleep(settings.worker_poll_seconds)
            continue
        async with engine.begin() as conn:
            # 先救回卡死的任务，再领取下一个
            revived = await queue.requeue_stale(conn, settings.worker_stale_job_seconds)
            job = await queue.claim_next(conn, worker_id)
            telemetry.current().set_queue_length(await queue.count_queued(conn))
        if revived:
            logger.warning("put %d stalled job(s) back in the queue", revived)
        if job is None:
            if once:
                return handled
            await sleep(settings.worker_poll_seconds)
            continue
        logger.info("job %s: document %s, attempt %d", job.id, job.document_id, job.attempt)
        await process_job(
            engine, job, storage=storage, embedder=embedder, settings=settings, chat=chat
        )
        handled += 1
