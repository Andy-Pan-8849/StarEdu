"""文件：ingest/parsers/common.py
作用：各解析器共用的小工具：把表格统一渲染成 Markdown、识别并丢弃示例文档顶部的元数据表、
  去掉加粗标记。
主要思想：不管原文件是 docx、pdf 还是 md，表格都变成同一种 Markdown 形式，
  后面的切块/检索不用关心格式。
"""

import re

from starit_core.ingest.models import Block

# The metadata block at the top of every sample document repeats what the manifest already says.
# 示例文档顶部都有一张元数据表，内容与清单(manifest)重复，解析时丢掉
META_KEYS = ("doc_id", "version", "status", "effective_date", "access", "campus_scope")
META_LABELS = ("Document ID", "Version", "Status", "Effective", "Audience", "Campus scope")


def render_table(rows: list[list[str]]) -> str:
    """把二维数组渲染成 Markdown 表格文字：压缩单元格空白、补齐列数、丢掉全空行。"""
    rows = [[" ".join(cell.split()) for cell in row] for row in rows if any(c.strip() for c in row)]
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    lines = ["| " + " | ".join(rows[0]) + " |", "|" + "|".join(["---"] * width) + "|"]
    lines += ["| " + " | ".join(r) + " |" for r in rows[1:]]
    return "\n".join(lines)


def table_block(rows: list[list[str]], page: int | None = None) -> Block | None:
    """用行数据生成一个 table 类型的 Block；表为空则返回 None。"""
    text = render_table(rows)
    return Block("table", text, page=page) if text else None


def is_metadata_table(rows: list[list[str]]) -> bool:
    """第一格是“Document ID”的表就是顶部元数据表。"""
    return bool(rows) and bool(rows[0]) and rows[0][0].strip() == META_LABELS[0]


# 匹配 **加粗** 或 __加粗__ 的标记
_EMPHASIS = re.compile(r"(\*\*|__)(.+?)\1")


def strip_emphasis(text: str) -> str:
    """去掉加粗标记，只留文字。"""
    return _EMPHASIS.sub(r"\2", text)
