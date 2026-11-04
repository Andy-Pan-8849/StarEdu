"""Checks qa-set.jsonl against the documents: every `facts` entry of a question must appear in the
source documents it names (case-insensitive, thousands separators ignored). Exit status 1 and a
list of problems when something does not. Standard library only."""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES = sorted((ROOT / "_markdown-source").rglob("*.md"))


def normal(text: str) -> str:
    return re.sub(r"(?<=\d),(?=\d)", "", text).lower()


def source_text(doc_code: str) -> str:
    parts = [p.read_text(encoding="utf-8") for p in SOURCES if p.name.startswith(doc_code + "_")]
    return normal("\n".join(parts))


def problems() -> list[str]:
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
