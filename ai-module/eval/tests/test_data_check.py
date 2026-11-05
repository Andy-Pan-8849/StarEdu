"""文件：测试——数据题评测
测什么：题库包含各种类型；判分规则（该回答/该拒绝/其他结局）；估算按每题四个步骤计；
报告会列出失败的题；命令行参数解析。
"""

import pytest
from starit_core.config import Settings
from starit_eval.cli import parse_args
from starit_eval.data_check import (
    DataQuestion,
    DataResult,
    DataRun,
    estimate,
    judge,
    load_data_questions,
    render,
)


def q(expected: str, *, should_answer: bool = True) -> DataQuestion:
    return DataQuestion("SQL-99", "sql", "how many?", expected, "x", "staff", should_answer)


def test_the_question_file_has_all_kinds() -> None:
    questions = load_data_questions()
    assert len(questions) == 41
    assert {x.type for x in questions} == {"sql", "sql-scope", "tool", "tool-scope"}
    assert sum(not x.should_answer for x in questions) == 9


@pytest.mark.parametrize(
    ("expected", "answer", "ok"),
    [
        ("5", "There are 5 claims [1].", True),
        ("5", "There are 15 claims [1].", False),
        ("5", "About 5.5 on average", False),
        ("1,234", "Total: CNY 1234 [1]", True),
        ("C0035, C0036", "Claims C0035 and C0036 [1]", True),
        ("C0035, C0036", "Claim C0035 only [1]", False),
        ("students: 3, staff: 2", "3 from students, 2 from staff [1]", True),
        ("paid", "Its status is Paid [1]", True),
        ("paid", "Its status is pending [1]", False),
        ("82.5", "The average is 82.5 [1]", True),
        ("81.5", "Your average is 81.5000000000000000. [1]", True),
        ("81.5", "Your average is 81.6000000000000000. [1]", False),
    ],
)
def test_judging_an_answer(expected: str, answer: str, ok: bool) -> None:
    assert (judge(q(expected), "answered", answer) == []) is ok


def test_an_unanswered_question_fails_when_an_answer_was_expected() -> None:
    assert judge(q("5"), "not_found", "no data")


@pytest.mark.parametrize("state", ["no_permission", "not_found"])
def test_a_refusal_passes_when_refusal_was_expected(state: str) -> None:
    assert judge(q("x", should_answer=False), state, "nothing") == []


@pytest.mark.parametrize("state", ["answered", "error", "refused"])
def test_anything_else_fails_a_must_refuse_question(state: str) -> None:
    assert judge(q("x", should_answer=False), state, "42 rows")


def test_estimate_counts_four_steps_per_question() -> None:
    calls, _ = estimate(Settings(_env_file=None), load_data_questions())
    assert calls == {"understand": 41, "plan": 41, "sql": 41, "answer": 41}


def test_the_report_lists_failures() -> None:
    bad = DataResult(q("5"), "answered", None, False, ["answer lacks '5'"], 1.0, "six", 4)
    text = render(DataRun(results=[bad]), None)
    assert "Passed 0 of 1" in text and "answer lacks '5'" in text and "> six" in text


def test_the_data_command_parses() -> None:
    args = parse_args(["data", "--only", "SQL-07", "--yes"])
    assert args.command == "data" and args.only == ["SQL-07"] and args.yes
