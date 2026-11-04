"""The questions' `facts` are checked against the documents by sample-data/tools/check_qa_facts.py;
this runs the same check in the test suite, so a typo in a question cannot become a "wrong answer"."""

import importlib.util
import json
from types import ModuleType

from starit_eval.dataset import SAMPLE_DATA, load_questions

TOOLS = SAMPLE_DATA / "tools"


def load_checker() -> ModuleType:
    spec = importlib.util.spec_from_file_location("check_qa_facts", TOOLS / "check_qa_facts.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_every_fact_is_in_its_source_documents() -> None:
    problems: list[str] = load_checker().problems()
    assert problems == []


def test_the_extra_questions_are_all_in_the_file_once() -> None:
    ids = [q.id for q in load_questions()]
    assert len(ids) == len(set(ids)) == 114


def test_the_added_questions_meet_the_promised_coverage() -> None:
    questions = load_questions()
    kinds = [q.type for q in questions]
    assert min(kinds.count(k) for k in ("keyword", "version", "paraphrase", "unanswerable")) >= 8
    assert sum(q.role in ("manager", "hr", "finance") for q in questions) >= 6 + 3
    restricted = {"HR-REC-002", "FIN-PAY-005", "FIN-BUD-007", "TS-IT-010"}
    for (
        doc
    ) in restricted:  # each restricted document has a question from a role that may not read it
        assert any(
            doc in q.source_docs and not q.should_answer and q.type == "access" for q in questions
        ), doc
    assert {"Admin", "RAGETLAdmin"} <= {q.role for q in questions}
    assert json.dumps([q.facts for q in questions])
