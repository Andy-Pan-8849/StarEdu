"""文件：scripts/ingest_samples.py
作用：登记示例文档并排入库任务（make ingest-samples）。
选项：--wait 等任务做完并打印结果；--process 在本进程里直接跑一遍 worker，不依赖 worker 容器；
  --force 即使没变化也全部重新入库（比如换了嵌入模型）。
会调用嵌入模型（花钱），先确认再运行。
"""

import argparse
import asyncio
import time
from pathlib import Path

from sqlalchemy import text
from starit_core.config import get_settings
from starit_core.db import create_engine
from starit_core.embeddings import embedding_client
from starit_core.ingest.register import register_from_manifest
from starit_core.ingest.worker import run_worker
from starit_core.llm import chat_client
from starit_core.storage import S3Storage

DOCUMENTS = Path(__file__).resolve().parent.parent / "sample-data" / "documents"


async def main(wait: bool, process: bool, force: bool) -> None:
    """登记文档（打印新登记/更新/未变化各几份）；按选项运行 worker；等待并列出失败的文档。"""
    settings = get_settings()
    engine = create_engine(settings)
    storage = S3Storage(settings)
    await storage.ensure_bucket()
    results = await register_from_manifest(engine, storage, DOCUMENTS, force=force)
    for action in ("registered", "updated", "unchanged"):
        print(f"{action}: {sum(r.action == action for r in results)}")

    if process:
        await run_worker(
            engine,
            storage,
            embedding_client(settings),
            settings,
            once=True,
            chat=chat_client(settings),
        )
    if wait or process:
        # 最多等 10 分钟：每 3 秒看一次状态分布，没有排队/运行中的就结束
        deadline = time.monotonic() + 600
        while time.monotonic() < deadline:
            async with engine.connect() as conn:
                rows = (
                    await conn.execute(
                        text("SELECT ingest_status, count(*) FROM ai.documents GROUP BY 1")
                    )
                ).all()
            counts = {status: n for status, n in rows}
            print(counts)
            if not counts.get("queued") and not counts.get("running"):
                break
            await asyncio.sleep(3)
        async with engine.connect() as conn:
            failed = (
                await conn.execute(
                    text(
                        "SELECT d.doc_code, d.version, j.stage, j.error_code, j.error_message "
                        "FROM ai.documents d JOIN ai.ingestion_jobs j ON j.document_id = d.id "
                        "WHERE d.ingest_status = 'failed'"
                    )
                )
            ).all()
        for row in failed:
            print("FAILED", *row)
    await engine.dispose()


if __name__ == "__main__":
    arguments = argparse.ArgumentParser()
    arguments.add_argument("--wait", action="store_true")
    arguments.add_argument("--process", action="store_true")
    arguments.add_argument("--force", action="store_true")
    parsed = arguments.parse_args()
    asyncio.run(main(parsed.wait, parsed.process, parsed.force))
