"""文件：ingest/identifiers.py
作用：从文本里抽取精确编号（错误码、文档编号、税号等）。
主要思想：关键词检索必须能精确找到这类编号（向量检索对它们不可靠），
所以把它们单独存一列并建索引，大小写保持原样。
"""

import re
from collections.abc import Iterable

# Hyphenated codes such as ERR-PORTAL-403, TS-NET-009, FIN-REIM-002, STC-2.
# 连字符编号：ERR-PORTAL-403、TS-NET-009、FIN-REIM-002、STC-2 等
_HYPHENATED = re.compile(r"\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b")
# Long mixed letter-and-digit numbers such as the 18-character tax ID 91510000FAKE00001X.
# 长的字母数字混合编号：如 18 位税号 91510000FAKE00001X
_LONG_ALNUM = re.compile(r"\b(?=[A-Z0-9]*[0-9])(?=[A-Z0-9]*[A-Z])[A-Z0-9]{12,}\b")


def extract_identifiers(text: str, extra: Iterable[str] = ()) -> list[str]:
    """返回文本里出现的编号（去重、保持出现顺序）。extra 是额外必须包含的编号，如文档自己的编号。"""
    found: dict[str, None] = {}
    for value in extra:
        found.setdefault(value, None)
    for pattern in (_HYPHENATED, _LONG_ALNUM):
        for match in pattern.finditer(text):
            found.setdefault(match.group(0), None)
    return list(found)
