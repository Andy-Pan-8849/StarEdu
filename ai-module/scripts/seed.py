"""为新环境准备好一切可用的数据（make seed）。

文件：scripts/seed.py
作用：让一个刚启动的空环境变得可用，分三步：
  1. 载入示例业务表（biz 模式，通过 ai_sql 视图读取）；
  2. 知识库：默认从预制转储 seed/ai-seed.jsonl.gz 恢复（不需要任何模型密钥）；
     加 --ingest 则用真实入库流水线重新建（需要嵌入模型的密钥）；
  3. 把示例文档的原文件放进对象存储，让引用能点开看原文。
Keycloak 的域和演示账号在服务启动时自动导入，不在这里。
说明：命令行 --help 里显示的描述取本文档字符串的第一行。
"""

import argparse
import asyncio
import sys
from pathlib import Path

from sqlalchemy import create_engine as create_sync_engine
from sqlalchemy import text
from starit_core.config import get_settings
from starit_core.db import create_engine
from starit_core.embeddings import embedding_client
from starit_core.ingest.register import register_from_manifest
from starit_core.ingest.worker import run_worker
from starit_core.llm import chat_client
from starit_core.seed_ai import load_ai, read_dump, upload_originals
from starit_core.seed_biz import load_biz
from starit_core.storage import S3Storage

# 仓库里的预制转储、示例文档位置
ROOT = Path(__file__).resolve().parent.parent
DUMP = ROOT / "seed" / "ai-seed.jsonl.gz"
DOCUMENTS = ROOT / "sample-data" / "documents"


async def main(ingest: bool) -> None:
    """执行播种。

    参数：ingest——为真时用真实流水线入库，否则从转储恢复。
    转储里的向量模型与当前配置不一致时只警告：检索只比较同一模型的向量，不一致会搜不到。
    """
    settings = get_settings()

    # 业务表需要库所有者账号来写（应用账号读不了 biz 表）
    owner = create_sync_engine(settings.migration_database_url)
    with owner.begin() as conn:
        counts = load_biz(conn, ROOT / "sample-data" / "structured")
    owner.dispose()
    print("business tables:", ", ".join(f"{t}={n}" for t, n in counts.items()))

    storage = S3Storage(settings)
    await storage.ensure_bucket()
    engine = create_engine(settings)
    try:
        if ingest:
            await register_from_manifest(engine, storage, DOCUMENTS, force=True)
            await run_worker(
                engine, storage, embedding_client(settings), settings, once=True,
                chat=chat_client(settings),
            )  # fmt: skip
            print("knowledge base: ingested with the real pipeline")
        else:
            if not DUMP.exists():
                raise SystemExit(f"{DUMP} is missing; run `make seed ARGS=--ingest` instead")
            data = DUMP.read_bytes()
            header, _ = read_dump(data)
            if header["embedding_models"] != settings.embedding_model:
                print(
                    f"warning: the dump has {header['embedding_models']} vectors but the "
                    f"configured model is {settings.embedding_model}; search only compares "
                    "vectors of the same model",
                    file=sys.stderr,
                )
            restored = await load_ai(engine, data)
            print("knowledge base: restored from the dump:", restored)
            print("original files:", await upload_originals(storage, DOCUMENTS))
        async with engine.connect() as conn:
            ready = (
                await conn.execute(
                    text("SELECT count(*) FROM ai.documents WHERE ingest_status = 'ready'")
                )
            ).scalar_one()
        print(f"{ready} document(s) ready")
    finally:
        await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--ingest", action="store_true", help="build with the real pipeline")
    asyncio.run(main(parser.parse_args().ingest))
