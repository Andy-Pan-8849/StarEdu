"""文件：main.py
作用：入库 worker 的命令行入口：`starit-worker` 常驻运行；加 `--once` 处理完现有任务就退出。
主要思想：启动时确保对象存储的桶存在，装配好嵌入客户端、聊天客户端(衍生内容用)、每日预算，
然后调用 starit_core.ingest.worker.run_worker 开始循环。
"""

import argparse
import asyncio
import logging
from collections.abc import Sequence

from starit_core.config import get_settings
from starit_core.cost import make_budget
from starit_core.db import create_engine
from starit_core.embeddings import embedding_client
from starit_core.ingest.worker import run_worker
from starit_core.llm import chat_client
from starit_core.logging import configure_logging
from starit_core.storage import S3Storage
from starit_core.telemetry import instrument_engine, setup_telemetry

logger = logging.getLogger("starit.worker")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """解析命令行：--once 表示只处理就绪的任务然后退出。"""
    parser = argparse.ArgumentParser(prog="starit-worker", description="Document ingestion worker")
    parser.add_argument("--once", action="store_true", help="process the ready jobs, then exit")
    return parser.parse_args(argv)


async def _run(once: bool) -> None:
    """装配依赖并运行 worker 循环；退出时释放数据库引擎。"""
    settings = get_settings()
    setup_telemetry(settings, "starit-worker")
    engine = create_engine(settings)
    instrument_engine(engine)
    storage = S3Storage(settings)
    await storage.ensure_bucket()
    budget = make_budget(settings)
    embedder = embedding_client(settings, budget)
    logger.info(
        "worker started (embedding %s/%s, %d dimensions)",
        settings.embedding_provider, embedder.model, embedder.dimensions,
    )  # fmt: skip
    try:
        await run_worker(engine, storage, embedder, settings, once=once, chat=chat_client(settings))
    finally:
        await engine.dispose()


def main(argv: Sequence[str] | None = None) -> None:
    """进程入口：解析参数、配置日志、运行事件循环。"""
    args = parse_args(argv)
    configure_logging(get_settings().log_level)
    asyncio.run(_run(args.once))


if __name__ == "__main__":
    main()
