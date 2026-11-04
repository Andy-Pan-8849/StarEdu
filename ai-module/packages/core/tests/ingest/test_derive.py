import json
from typing import Any

import pytest
from sqlalchemy.dialects import postgresql
from starit_core.ingest.derive import DERIVE_MODES, Derived, derive_chunks
from starit_core.ingest.models import Chunk
from starit_core.ingest.pipeline import embedding_input
from starit_core.llm import ChatError
from starit_core.retrieval.keyword import keyword_statement
from starit_core.testing import ScriptedChat


def chunk(text: str = "The hotel limit is CNY 600 per night.") -> Chunk:
    return Chunk(
        index=0, text=text, heading_path=("2. Hotels",), page=None, token_count=9, identifiers=()
    )


def reply(
    summary: str = "Hotels cost up to 600.",
    questions: Any = ("How much can I spend on a hotel?", "What is the nightly cap?"),
) -> str:
    return json.dumps({"summary": summary, "questions": list(questions)})


async def test_none_asks_the_model_nothing() -> None:
    chat = ScriptedChat()
    assert await derive_chunks(chat, "m", "Travel", [chunk()], "none") == [[]]
    assert chat.calls == []


@pytest.mark.parametrize(
    ("mode", "kinds"),
    [
        ("summary", ["summary"]),
        ("questions", ["question", "question"]),
        ("all", ["summary", "question", "question"]),
    ],
)
async def test_each_mode_keeps_only_what_was_asked_for(mode: str, kinds: list[str]) -> None:
    chat = ScriptedChat(derive=reply())
    result = await derive_chunks(chat, "m", "Travel", [chunk()], mode)
    assert [d.kind for d in result[0]] == kinds


async def test_the_prompt_carries_the_title_section_and_text_but_no_other_chunk() -> None:
    chat = ScriptedChat(derive=reply())
    await derive_chunks(chat, "m", "Travel Policy", [chunk("first"), chunk("second")], "all")
    prompts = chat.prompts("derive")
    assert len(prompts) == 2 and "Travel Policy" in prompts[0] and "2. Hotels" in prompts[0]
    assert "first" in prompts[0] and "second" not in prompts[0]


async def test_a_failing_model_or_bad_json_only_loses_that_chunks_aids() -> None:
    chat = ScriptedChat(derive=[ChatError("down"), "not json", reply()])
    result = await derive_chunks(chat, "m", "T", [chunk(), chunk(), chunk()], "all")
    assert [len(r) for r in result] == [0, 0, 3]


async def test_at_most_three_questions_and_blanks_are_dropped() -> None:
    chat = ScriptedChat(derive=reply(summary="  ", questions=["a?", "", "b?", "c?", "d?"]))
    result = await derive_chunks(chat, "m", "T", [chunk()], "all")
    assert [d.text for d in result[0]] == ["a?", "b?", "c?"]


async def test_an_unknown_mode_is_refused() -> None:
    with pytest.raises(ValueError):
        await derive_chunks(ScriptedChat(), "m", "T", [chunk()], "everything")
    assert DERIVE_MODES == ("none", "summary", "questions", "all")


def test_derived_content_is_added_to_what_is_embedded_never_instead() -> None:
    plain = embedding_input("Travel", chunk())
    enriched = embedding_input(
        "Travel",
        chunk(),
        [Derived("summary", "Hotels cost up to 600."), Derived("question", "How much?")],
    )
    assert enriched.startswith(plain)
    assert enriched.endswith("Hotels cost up to 600.\nHow much?")


def test_the_identifier_boost_can_be_switched_off() -> None:
    def sql(boost: bool) -> str:
        statement = keyword_statement("What does ERR-PORTAL-403 mean?", 5, None, boost)
        return str(statement.compile(dialect=postgresql.dialect()))  # type: ignore[no-untyped-call]

    assert "identifiers" in sql(True)
    assert "identifiers &&" not in sql(False) and "identifiers" not in sql(False)
