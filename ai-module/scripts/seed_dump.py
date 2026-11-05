"""文件：scripts/seed_dump.py
作用：把正在运行的数据库里的知识库写成 seed/ai-seed.jsonl.gz（make seed-dump）。
注意：只能从“用真实嵌入模型入库”的数据库导出——这个文件是别人 `make seed` 时恢复的内容，
这样他们不需要 OpenAI 密钥。所以空库或假向量都会被拒绝。
"""

import asyncio
import subprocess
from pathlib import Path

from starit_core.config import get_settings
from starit_core.db import create_engine
from starit_core.seed_ai import dump_ai, read_dump

TARGET = Path(__file__).resolve().parent.parent / "seed" / "ai-seed.jsonl.gz"


def git_sha() -> str | None:
    """当前提交的短哈希，写进转储文件头便于追溯；取不到返回 None。"""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True
        )
    except OSError:
        return None
    return out.stdout.strip() or None


async def main() -> None:
    """导出知识库并检查：必须有文档、向量不能是假的，然后写文件。"""
    engine = create_engine(get_settings())
    try:
        data = await dump_ai(engine, git_sha=git_sha())
    finally:
        await engine.dispose()
    header, _ = read_dump(data)
    if not header["counts"]["documents"]:
        raise SystemExit("the database has no documents: run `make ingest-samples` first")
    if "fake" in str(header["embedding_models"]):
        raise SystemExit("these vectors are fake; ingest with a real embedding model first")
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_bytes(data)
    print(f"wrote {TARGET} ({len(data)} bytes)")
    print(f"  {header['counts']}, models {header['embedding_models']}")


if __name__ == "__main__":
    asyncio.run(main())
