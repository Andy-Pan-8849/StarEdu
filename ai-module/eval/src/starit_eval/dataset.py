"""The evaluation questions and the demo accounts that ask them."""

import csv
import json
from dataclasses import dataclass
from pathlib import Path

from starit_core.auth import Identity

AI_MODULE = Path(__file__).resolve().parents[3]
SAMPLE_DATA = AI_MODULE / "sample-data"
BUSINESS_ROLES = ("student", "staff", "manager", "hr", "finance")
ALL_ROLES = (*BUSINESS_ROLES, "Admin", "RAGETLAdmin")


@dataclass(frozen=True)
class Question:
    id: str
    type: str
    role: str
    question: str
    expected_answer: str
    source_docs: tuple[str, ...]
    should_answer: bool


def load_questions(path: Path | None = None) -> list[Question]:
    path = path or SAMPLE_DATA / "eval" / "qa-set.jsonl"
    questions = []
    for line in path.read_text(encoding="utf-8").splitlines():
        row = json.loads(line)
        questions.append(
            Question(
                id=row["id"],
                type=row["type"],
                role=row["role"],
                question=row["question"],
                expected_answer=row["expected_answer"],
                source_docs=tuple(row["source_docs"]),
                should_answer=bool(row["should_answer"]),
            )
        )
    return questions


def load_manifest(path: Path | None = None) -> dict[tuple[str, str], dict[str, str]]:
    """(doc_code, version) -> manifest row, for the independent permission check."""
    path = path or SAMPLE_DATA / "documents" / "manifest.csv"
    with open(path, newline="", encoding="utf-8") as handle:
        return {(r["doc_id"], r["version"]): r for r in csv.DictReader(handle)}


def load_identities(path: Path | None = None) -> dict[str, Identity]:
    """One demo account per role: the first one listed in demo-accounts.csv."""
    path = path or SAMPLE_DATA / "demo-accounts.csv"
    identities: dict[str, Identity] = {}
    with open(path, newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            if row["role"] in identities:
                continue
            student = row["subject_type"] == "student"
            identities[row["role"]] = Identity(
                user_id=row["username"],
                username=row["username"],
                name=row["name"],
                roles=frozenset({row["role"]}),
                campus_id=row["campus_id"],
                level=row["level"] or None,
                employee_id=None if student else row["subject_id"],
                student_id=row["subject_id"] if student else None,
            )
    return identities
