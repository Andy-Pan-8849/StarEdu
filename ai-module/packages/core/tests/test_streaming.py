import json
import random

import pytest
from starit_core.streaming import AnswerStream


def run(
    text: str, sizes: list[int] | None = None, require_sufficient: bool = True
) -> tuple[str, AnswerStream]:
    """Feed `text` in chunks of the given sizes (cycled); return what was released."""
    parser = AnswerStream(require_sufficient=require_sufficient)
    out: list[str] = []
    sizes = sizes or [len(text)]
    i = n = 0
    while i < len(text):
        size = sizes[n % len(sizes)]
        out += parser.feed(text[i : i + size])
        i += size
        n += 1
    return "".join(out), parser


def reply(answer: str, sufficient: bool = True, citations: tuple[int, ...] = (1,)) -> str:
    return json.dumps({"sufficient": sufficient, "answer": answer, "citations": list(citations)})


ANSWERS = [
    "The limit is CNY 600 per night [1].",
    "",
    "Line one\nLine two\twith a tab",
    'She said "quote" and used a back\\slash',
    "Unicode: 酒店限额 600 元，请按标准报销。",
    "Emoji and astral: 😀 𝄞 done",
    "Slash / and control \u0001 char",
    "Brace } and bracket ] and comma , and colon : inside",
    "Trailing backslash at the end \\",
    "x" * 3000,
]


@pytest.mark.parametrize("answer", ANSWERS)
@pytest.mark.parametrize("ensure_ascii", [True, False])
def test_the_answer_comes_out_whole_however_the_reply_is_cut(
    answer: str, ensure_ascii: bool
) -> None:
    text = json.dumps(
        {"sufficient": True, "answer": answer, "citations": [1, 2]}, ensure_ascii=ensure_ascii
    )
    for sizes in ([len(text)], [1], [2], [3], [5], [7, 1, 2], [13], [64]):
        released, parser = run(text, sizes)
        assert released == answer, (sizes, released[:40])
        assert parser.emitted == answer and parser.sufficient is True and not parser.deferred


def test_every_single_cut_point_gives_the_same_answer() -> None:
    answer = 'Quote " and \\ slash, newline \n, é, 𝄞, \\u00e9 text'
    text = reply(answer)
    for cut in range(len(text) + 1):
        parser = AnswerStream()
        pieces = parser.feed(text[:cut]) + parser.feed(text[cut:])
        assert "".join(pieces) == answer, cut


def test_random_cuts_never_change_the_result() -> None:
    rng = random.Random(7)
    answer = 'Mixed: abc "q" \n 酒店 😀 \\ / end'
    text = reply(answer, citations=(1, 2, 3))
    for _ in range(300):
        sizes = [rng.randint(1, 9) for _ in range(rng.randint(1, 6))]
        assert run(text, sizes)[0] == answer


def test_insufficient_releases_nothing() -> None:
    text = reply("", sufficient=False, citations=())
    assert run(text, [1])[0] == ""
    text = json.dumps({"sufficient": False, "answer": "I made this up", "citations": []})
    released, parser = run(text, [2])
    assert released == "" and parser.sufficient is False and parser.emitted == ""


def test_text_waits_for_sufficient_and_never_leaks_before_it() -> None:
    # Whitespace and ordering variations of the keys.
    text = '{ "sufficient" :  true ,\n  "answer" : "ok [1]" , "citations": [1] }'
    assert run(text, [1])[0] == "ok [1]"
    pieces = []
    parser = AnswerStream()
    for chunk in ('{"suff', 'icient": tr', 'ue, "answer": "hel', 'lo"', ', "citations": []}'):
        pieces.append(parser.feed(chunk))
    assert pieces[0] == [] and pieces[1] == [] and pieces[2] == ["hel"] and pieces[3] == ["lo"]


def test_an_answer_written_before_sufficient_is_deferred_not_leaked() -> None:
    text = '{"answer": "Early answer", "sufficient": true, "citations": [1]}'
    released, parser = run(text, [1])
    assert released == "" and parser.deferred is True and parser.sufficient is True


def test_without_the_sufficient_requirement_the_answer_streams_at_once() -> None:
    text = '{"answer": "from data [1]"}'
    released, parser = run(text, [2], require_sufficient=False)
    assert released == "from data [1]" and not parser.deferred


def test_other_values_are_skipped_whatever_they_contain() -> None:
    text = json.dumps(
        {
            "meta": {"answer": "NOT THIS", "list": [1, "}", {"answer": "nor this"}], "s": 'q"}'},
            "note": 'string with "escaped" quotes and } braces',
            "n": -12.5e3,
            "flag": None,
            "sufficient": True,
            "answer": "THIS",
            "citations": [[1], {"a": "}"}],
        }
    )
    assert run(text, [1])[0] == "THIS"
    assert run(text, [4])[0] == "THIS"


def test_a_nested_answer_key_is_not_the_answer() -> None:
    text = '{"sufficient": true, "extra": {"answer": "inner"}, "answer": "outer"}'
    assert run(text, [1])[0] == "outer"


@pytest.mark.parametrize(
    "text",
    [
        "",
        "not json at all",
        '{"sufficient": true, "answer": ',
        '{"sufficient": true, "answer": 42}',
        '{"sufficient": true, "answer": null}',
        '{"sufficient": "true", "answer": "x"}',
        "[1, 2, 3]",
        '{"sufficient": true "answer": "x"}',
    ],
)
def test_malformed_replies_do_not_crash_and_release_only_what_is_safe(text: str) -> None:
    released, parser = run(text, [3])
    assert isinstance(released, str)
    assert parser.emitted == released
    if '"sufficient": "true"' in text:
        assert released == ""  # only the literal true opens the gate


def test_a_lone_surrogate_becomes_a_replacement_character_not_an_error() -> None:
    assert run('{"sufficient": true, "answer": "a\\ud83dz"}', [1])[0] == "a�z"
    assert run('{"sufficient": true, "answer": "a\\ude00z"}', [1])[0] == "a�z"
    assert run('{"sufficient": true, "answer": "a\\uZZZZz"}', [1])[0] == "a�z"
    assert run('{"sufficient": true, "answer": "a\\qz"}', [1])[0] == "a�z"


def test_what_is_released_is_always_a_prefix_of_the_final_answer() -> None:
    answer = "A prefix property: 酒店 \n 😀 end"
    text = reply(answer)
    parser = AnswerStream()
    shown = ""
    for ch in text:
        shown += "".join(parser.feed(ch))
        assert answer.startswith(shown)
    assert shown == answer


def test_text_after_the_object_is_ignored() -> None:
    assert run(reply("x") + '  {"answer": "again"}', [3])[0] == "x"
