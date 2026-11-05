"""文件：sample-data/tools/check_qa_facts.py
作用：核对题库 qa-set.jsonl：每道题的每个 facts（必须出现的数字、编号、词）都必须真的出现在
它所指的源文档里（不分大小写，忽略千分位逗号）。有问题则列出并以状态 1 退出。只用标准库。
为什么需要：防止参考答案本身写错，否则评测时“答错”其实是题目出错。
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES = sorted((ROOT / "_markdown-source").rglob("*.md"))


def normal(text: str) -> str:
    """统一写法再比较：转小写、去掉数字间的千分位逗号。"""
    return re.sub(r"(?<=\d),(?=\d)", "", text).lower()


def source_text(doc_code: str) -> str:
    """某个文档编号对应的全部源文档文字（合并后统一写法）。"""
    parts = [p.read_text(encoding="utf-8") for p in SOURCES if p.name.startswith(doc_code + "_")]
    return normal("\n".join(parts))


def problems() -> list[str]:
    """找出所有对不上的 facts，返回问题描述列表（空表示全部核对通过）。"""
    found: list[str] = []
    seen_ids: set[str] = set()
    for line in (ROOT / "eval" / "qa-set.jsonl").read_text(encoding="utf-8").splitlines():
        q = json.loads(line)
        if q["id"] in seen_ids:
            found.append(f"{q['id']}: duplicate id")
        seen_ids.add(q["id"])
        for doc in q["source_docs"]:
            if not source_text(doc):
                found.append(f"{q['id']}: unknown source document {doc}")
        if q["should_answer"] and q.get("facts") and q["source_docs"]:
            haystack = "".join(source_text(d) for d in q["source_docs"])
            found += [f"{q['id']}: fact {f!r} is not in {q['source_docs']}" for f in q["facts"] if normal(f) not in haystack]
        if q["should_answer"] and not q["source_docs"]:
            found.append(f"{q['id']}: an answerable question needs a source document")
    return found


if __name__ == "__main__":
    bad = problems()
    print("\n".join(bad) if bad else "all facts are in their source documents")
    sys.exit(1 if bad else 0)
