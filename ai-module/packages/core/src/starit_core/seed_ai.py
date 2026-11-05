"""文件：seed_ai.py
作用：保存和恢复知识库（文档、文本块、向量、衍生内容）。
主要思想：转储文件是一次真实入库的产物，写成 gzip 压缩的 JSON 行（首行是文件头，
  之后每行一条记录）。
恢复它就能得到一个可用的知识库，不需要模型密钥——`make seed` 就是这么做的。
对话、审计、评测结果不在其中。
读写都通过 Postgres 自己的 row_to_json / jsonb_populate_recordset，
所以数组、日期、pgvector 等所有类型都走 Postgres 的文本形式，
以后迁移新增的列也不用改本文件；生成列(全文检索向量)不导出，恢复时由数据库重算。
"""

import csv
import gzip
import io
import json
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

# 转储格式版本；格式变了要升版本，旧文件会被拒绝
FORMAT = 1
# 要导出的表，顺序是“父表在前，子表在后”（恢复时按此顺序插入）
TABLES = ("documents", "document_chunks", "chunk_embeddings", "chunk_derived")
BATCH = 100


class SeedError(Exception):
    """转储文件无法按原样恢复（格式不认识、不完整、与权限不一致等）。"""


async def _columns(conn: AsyncConnection, table: str) -> list[str]:
    """某表可导出的列（排除生成列），按列顺序；表读不到则抛 SeedError。"""
    rows = await conn.execute(
        text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = 'ai' AND table_name = :t AND is_generated = 'NEVER' "
            "ORDER BY ordinal_position"
        ),
        {"t": table},
    )
    columns = [str(r[0]) for r in rows]
    if not columns:
        raise SeedError(f"table ai.{table} is not readable")
    return columns


async def dump_ai(engine: AsyncEngine, *, git_sha: str | None = None) -> bytes:
    """把知识库导出成转储文件的字节。

    参数：engine 数据库引擎；git_sha 记入文件头，便于追溯。
    返回：gzip 压缩的字节。mtime=0 让相同内容得到完全相同的字节（便于比较和提交）。
    """
    lines: list[str] = []
    async with engine.connect() as conn:
        counts: dict[str, int] = {}
        body: list[str] = []
        for table in TABLES:
            columns = await _columns(conn, table)
            selected = ", ".join(columns)
            rows = await conn.execute(
                text(
                    f"SELECT row_to_json(t)::text FROM (SELECT {selected} FROM ai.{table} "
                    "ORDER BY 1) t"
                )
            )
            found = [str(r[0]) for r in rows]
            counts[table] = len(found)
            body += [f'{{"t":"{table}","r":{row}}}' for row in found]
        model = (
            await conn.execute(
                text("SELECT string_agg(DISTINCT model, ',') FROM ai.chunk_embeddings")
            )
        ).scalar()
    header = {
        "format": FORMAT,
        "created": datetime.now(UTC).isoformat(timespec="seconds"),
        "git_sha": git_sha,
        "embedding_models": model,
        "counts": counts,
    }
    lines.append(json.dumps(header))
    lines += body
    buffer = io.BytesIO()
    # mtime=0 so the same content always gives the same bytes.
    with gzip.GzipFile(fileobj=buffer, mode="wb", mtime=0) as out:
        out.write(("\n".join(lines) + "\n").encode())
    return buffer.getvalue()


def read_dump(data: bytes) -> tuple[dict[str, Any], Iterator[tuple[str, dict[str, Any]]]]:
    """解析转储字节，返回（文件头, 逐条记录的迭代器）；空文件或格式不认识抛 SeedError。"""
    raw = gzip.decompress(data).decode().splitlines()
    if not raw:
        raise SeedError("the dump is empty")
    header = json.loads(raw[0])
    if header.get("format") != FORMAT:
        raise SeedError(f"unknown dump format {header.get('format')!r}")

    def rows() -> Iterator[tuple[str, dict[str, Any]]]:
        for line in raw[1:]:
            item = json.loads(line)
            yield item["t"], item["r"]

    return header, rows()


async def load_ai(engine: AsyncEngine, data: bytes, *, replace: bool = True) -> dict[str, int]:
    """在一个事务里恢复转储。

    参数：data 转储字节；replace 为真时先删除现有文档（块、向量、任务随外键级联删），
      否则表里不能有冲突。
    返回：各表恢复后的行数。
    校验：每表行数与文件头一致；恢复后文本块的权限必须与所属文档一致（v_chunk_permission_drift
      为 0）。
    """
    header, rows = read_dump(data)
    per_table: dict[str, list[dict[str, Any]]] = {t: [] for t in TABLES}
    for table, row in rows:
        if table not in per_table:
            raise SeedError(f"the dump has an unknown table {table!r}")
        per_table[table].append(row)
    for table in TABLES:
        if len(per_table[table]) != header["counts"].get(table):
            raise SeedError(f"the dump is incomplete: ai.{table}")

    async with engine.begin() as conn:
        if replace:
            await conn.execute(text("DELETE FROM ai.documents"))
        for table in TABLES:  # parents before children
            columns = ", ".join(await _columns(conn, table))
            statement = text(
                f"INSERT INTO ai.{table} ({columns}) SELECT {columns} "
                f"FROM jsonb_populate_recordset(NULL::ai.{table}, CAST(:rows AS jsonb))"
            )
            rows_of = per_table[table]
            for start in range(0, len(rows_of), BATCH):
                await conn.execute(statement, {"rows": json.dumps(rows_of[start : start + BATCH])})
        drift = (
            await conn.execute(text("SELECT count(*) FROM ai.v_chunk_permission_drift"))
        ).scalar_one()
        if drift:
            raise SeedError(f"{drift} restored chunk(s) disagree with their document's permissions")
        counts = {
            table: int((await conn.execute(text(f"SELECT count(*) FROM ai.{table}"))).scalar_one())
            for table in TABLES
        }
    return counts


async def upload_originals(storage: Any, documents_dir: Path) -> int:
    """把示例原文件放进对象存储，键与入库流水线给的一致，这样恢复出来的文档也能打开原文。
    返回文件数。
    """
    count = 0
    manifest = (documents_dir / "manifest.csv").read_text(encoding="utf-8").splitlines()
    for row in csv.DictReader(manifest):
        path = documents_dir / row["file"]
        await storage.put(
            f"documents/{row['doc_id']}/{row['version']}/{path.name}", path.read_bytes()
        )
        count += 1
    return count
