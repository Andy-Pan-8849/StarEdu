import pytest
from starit_core.config import Settings
from starit_eval.cli import estimate, parse_args
from starit_eval.dataset import Question
from starit_eval.pricing import cost_usd
from starit_eval.report import build_report, passed, render_markdown
from starit_eval.runner import ModeRun, QuestionRun, SweepResult

SETTINGS = Settings(_env_file=None)


def question(
    qid: str, kind: str = "single", sources: tuple[str, ...] = ("A",), answer: bool = True
) -> Question:
    return Question(qid, kind, "staff", f"question {qid}?", "expected", sources, answer)


def run(
    q: Question, docs: list[str], *, violations: list[str] | None = None, mode: str = "hybrid"
) -> QuestionRun:
    return QuestionRun(
        q, mode, "ning.adm.bj", docs, ["id"] * len(docs), 0.5, 12.0, False, violations or [], 0
    )


def test_passed_judges_answerable_and_refused_questions_differently() -> None:
    assert passed(run(question("1"), ["X", "A"])) is True
    assert passed(run(question("2"), ["X", "Y"])) is False
    assert passed(run(question("3"), ["A"], violations=["HR-X v1"])) is False  # a leak always fails
    restricted = question("4", "access", ("HR-REC-002",), answer=False)
    assert passed(run(restricted, ["X"])) is True  # the restricted document stayed out
    assert passed(run(restricted, ["HR-REC-002"])) is False
    assert passed(run(question("5", "unanswerable", (), answer=False), ["X"])) is None


def test_the_report_has_every_section_and_the_numbers_add_up() -> None:
    qs = [
        question("1"),
        question("2", "keyword", ("K",)),
        question("3", "unanswerable", (), answer=False),
    ]
    mode = ModeRun("hybrid", [run(qs[0], ["A"]), run(qs[1], ["X"]), run(qs[2], ["X"])])
    mode.rerank_input_tokens, mode.rerank_output_tokens = 2000, 100
    report = build_report(
        label="t", settings=SETTINGS, corpus={"documents": 28, "chunks": 39, "avg_tokens": 286},
        mode_runs=[mode], sweep=SweepResult(checked=10), embedding_tokens=1000,
        rerank_model="openai/gpt-6-luna", embedding_model="text-embedding-3-small",
    )  # fmt: skip
    overall = report["modes"]["hybrid"]["overall"]
    assert overall["n"] == 2 and overall["hit@6"] == 0.5  # only answerable questions with a source
    assert report["modes"]["hybrid"]["missed"] == ["2"]
    assert report["leak_sweep"] == {"checked": 10, "violations": []}
    assert report["cost"]["estimated_usd"] == pytest.approx(0.00002 + 0.0002 + 0.00005, rel=1e-3)
    text = render_markdown(report)
    for heading in ("## 总体结果", "## 按题型", "## 权限回归", "## 费用", "## 局限"):
        assert heading in text
    assert "| hybrid | 2 |" in text and "没有来源" in text


def test_a_leak_is_counted_and_shown() -> None:
    q = question("1")
    mode = ModeRun("keyword", [run(q, ["A"], violations=["FIN-X v1"], mode="keyword")])
    sweep = SweepResult(checked=1, violations=[("student", "1", "keyword", "FIN-X v1")])
    report = build_report(
        label="t", settings=SETTINGS, corpus={"documents": 1, "chunks": 1, "avg_tokens": 1},
        mode_runs=[mode], sweep=sweep, embedding_tokens=0, rerank_model="x", embedding_model="y",
    )  # fmt: skip
    assert report["modes"]["keyword"]["violations"] == 1
    assert "越权的块：1" in render_markdown(report)


def test_the_cli_needs_something_to_do() -> None:
    with pytest.raises(SystemExit):
        parse_args(["retrieval"])
    assert parse_args(["retrieval", "--all-modes"]).all_modes
    assert parse_args(["retrieval", "--mode", "keyword", "--mode", "vector", "--yes"]).mode == [
        "keyword",
        "vector",
    ]
    assert parse_args(["retrieval", "--leak-sweep"]).leak_sweep
    with pytest.raises(SystemExit):
        parse_args(["retrieval", "--mode", "fuzzy"])


def test_the_estimate_counts_only_the_calls_a_run_will_make() -> None:
    qs = [question(str(n)) for n in range(54)]
    none = estimate(SETTINGS, qs, ["keyword", "hybrid"], sweep=False, avg_capped=286)
    assert none["rerank_calls"] == 0 and none["rerank_input_tokens"] == 0
    assert none["embedding_calls"] == 1 and none["sweep_queries"] == 0
    full = estimate(SETTINGS, qs, ["hybrid_rerank"], sweep=True, avg_capped=286)
    assert full["rerank_calls"] == 54
    assert full["rerank_input_tokens"] == 54 * (160 + 20 * (286 + 40))
    assert full["sweep_queries"] == 7 * 54 * 3
    assert full["usd"] is not None and 0 < float(full["usd"]) < 1
    unknown = estimate(
        SETTINGS.model_copy(update={"model_rerank": "openai/some-new-model"}),
        qs,
        ["hybrid_rerank"],
        False,
        286,
    )
    assert unknown["usd"] is None


def test_prices() -> None:
    assert cost_usd("text-embedding-3-small", 1_000_000) == pytest.approx(0.02)
    assert cost_usd("openai/gpt-6-luna", 1_000_000, 1_000_000) == pytest.approx(0.60)
    assert cost_usd("openai/unlisted", 10) is None
