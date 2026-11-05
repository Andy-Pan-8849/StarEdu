"""文件：dataset.py
作用：载入评测用的题库、文档清单和演示账号。
内容：Question（一道题：角色、问题、参考答案、来源文档、该回答还是该拒绝、必须包含的事实）；
load_questions 读 qa-set.jsonl；load_manifest 读文档清单（独立越权检查用）；
load_identities 每个角色取演示账号里的第一个，生成 Identity。
"""

import csv
import json
from dataclasses import dataclass
from pathlib import Path

from starit_core.auth import Identity

# ai-module 目录与示例数据目录的位置
AI_MODULE = Path(__file__).resolve().parents[3]
SAMPLE_DATA = AI_MODULE / "sample-data"
# 五个业务角色，加上两个管理角色就是全部角色
BUSINESS_ROLES = ("student", "staff", "manager", "hr", "finance")
ALL_ROLES = (*BUSINESS_ROLES, "Admin", "RAGETLAdmin")


@dataclass(frozen=True)
class Question:
    """一道评测题。should_answer 为 False 表示助手应当拒绝或说找不到；facts
    是正确回答必须包含的数字、编号或词。
    """

    id: str
    type: str
    role: str
    question: str
    expected_answer: str
    source_docs: tuple[str, ...]
    should_answer: bool
    facts: tuple[str, ...] = ()  # figures, identifiers or words a correct answer must contain


def load_questions(path: Path | None = None) -> list[Question]:
    """读取题库（默认 sample-data/eval/qa-set.jsonl）。"""
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
                facts=tuple(row.get("facts", ())),
            )
        )
    return questions


def load_manifest(path: Path | None = None) -> dict[tuple[str, str], dict[str, str]]:
    """读取文档清单，返回 (文档编号, 版本) -> 清单行，供独立的越权检查使用。"""
    path = path or SAMPLE_DATA / "documents" / "manifest.csv"
    with open(path, newline="", encoding="utf-8") as handle:
        return {(r["doc_id"], r["version"]): r for r in csv.DictReader(handle)}


def load_identities(path: Path | None = None) -> dict[str, Identity]:
    """为每个角色生成一个演示身份（取 demo-accounts.csv 里该角色的第一个账号）。返回 角色 ->
    Identity。
    """
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
