import pytest
from starit_eval import metrics
from starit_eval.dataset import ALL_ROLES, load_identities, load_manifest, load_questions
from starit_eval.leak import READABLE_BY, may_read
from starit_eval.metrics import Scored


def test_hit_and_recall_count_documents_not_chunks() -> None:
    docs = ["A", "A", "B", "C", "A"]  # chunks of A come first, twice
    assert metrics.unique_in_order(docs) == ["A", "B", "C"]
    assert metrics.hit_at_k(docs, {"B"}, 1) is False
    assert metrics.hit_at_k(docs, {"B"}, 2) is True
    assert metrics.recall_at_k(docs, {"A", "C", "Z"}, 3) == pytest.approx(2 / 3)
    assert metrics.recall_at_k(docs, {"A", "C", "Z"}, 1) == pytest.approx(1 / 3)
    assert metrics.recall_at_k(docs, set(), 3) == 0.0


def test_reciprocal_rank_uses_the_first_source_document() -> None:
    assert metrics.reciprocal_rank(["X", "Y", "S"], {"S"}) == pytest.approx(1 / 3)
    assert metrics.reciprocal_rank(["S", "X"], {"S", "X"}) == 1.0
    assert metrics.reciprocal_rank(["X"], {"S"}) == 0.0
    assert metrics.reciprocal_rank([], {"S"}) == 0.0


def test_percentile_is_nearest_rank() -> None:
    values = [10.0, 20.0, 30.0, 40.0, 50.0]
    assert metrics.percentile(values, 50) == 30.0
    assert metrics.percentile(values, 95) == 50.0
    assert metrics.percentile([], 50) == 0.0
    assert metrics.percentile([7.0], 95) == 7.0


def test_summaries_by_type() -> None:
    items = [
        Scored("single", ("A", "X"), ("A",)),  # found at rank 1
        Scored("single", ("X", "Y", "A"), ("A",)),  # found at rank 3
        Scored("keyword", ("X",), ("K",)),  # missed
    ]
    overall = metrics.summarize(items)
    assert overall.n == 3
    assert overall.hit1 == pytest.approx(1 / 3)
    assert overall.hit3 == pytest.approx(2 / 3)
    assert overall.mrr == pytest.approx((1 + 1 / 3 + 0) / 3)
    by_type = metrics.summarize_by_type(items)
    assert list(by_type) == ["keyword", "single"]
    assert by_type["single"].hit6 == 1.0 and by_type["keyword"].hit6 == 0.0
    assert metrics.summarize([]).n == 0


def test_the_question_set_is_loaded_whole() -> None:
    questions = load_questions()
    assert len(questions) == 114
    assert sum(not q.should_answer for q in questions) == 27
    assert {q.role for q in questions} <= set(ALL_ROLES)
    # Every answerable question says what a correct answer must contain, or can be judged.
    assert all(q.source_docs for q in questions if q.should_answer)
    assert all(isinstance(q.source_docs, tuple) for q in questions)
    assert len(load_manifest()) == 28


def test_there_is_one_identity_per_role_with_the_right_ids() -> None:
    identities = load_identities()
    assert set(identities) == set(ALL_ROLES)
    student = identities["student"]
    assert student.student_id and student.employee_id is None
    assert identities["hr"].employee_id and identities["hr"].student_id is None
    assert all(len(i.roles) == 1 for i in identities.values())


@pytest.mark.parametrize("access", sorted(READABLE_BY))
def test_the_independent_access_rule_matches_the_documented_table(access: str) -> None:
    manifest = {("D", "1"): {"access": access}}
    readable = {role for role in ALL_ROLES if may_read({role}, "D", "1", manifest)}
    assert readable == set(READABLE_BY[access])
    assert not readable & {"Admin", "RAGETLAdmin"}


def test_an_unknown_document_is_never_readable() -> None:
    assert may_read({"hr"}, "NOPE", "1", {}) is False
