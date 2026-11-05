"""文件：测试——助手的流式事件（集成）
测什么：有客户端在监听时：回答边写边流出，结束时等于落库的回复；摘录不足时不展示任何文字；
流出的草稿校验失败会被撤回；固定话术一次性给出；模型连接中途断开以 error 结局结束。
"""

from collections.abc import Callable
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine
from starit_core.agent import messages
from starit_core.auth import Identity
from starit_core.testing import (
    Harness,
    ScriptedChat,
    StubRetrieval,
    candidate,
    generate_json,
    retrieval_result,
    understand_json,
)

pytestmark = pytest.mark.integration

GOOD = retrieval_result([candidate()])


@pytest.fixture
def harness(
    engines: tuple[AsyncEngine, AsyncEngine], make_identity: Callable[..., Identity]
) -> Harness:
    identity = make_identity(
        {"staff"}, user_id="ning.adm.bj", campus_id="BJ", level="S2", employee_id="E0014"
    )
    return Harness(engines[0], engines[1], identity)


class Events:
    def __init__(self) -> None:
        self.items: list[tuple[str, dict[str, Any]]] = []

    async def __call__(self, name: str, data: dict[str, Any]) -> None:
        self.items.append((name, data))

    @property
    def names(self) -> list[str]:
        return [n for n, _ in self.items]

    def shown(self) -> str:
        """The answer text as the client would have it on screen at the end."""
        text = ""
        for name, data in self.items:
            if name == "message.delta":
                text += data["text"]
            elif name == "message.retract":
                text = ""
        return text


async def test_an_answer_is_streamed_and_ends_equal_to_the_stored_reply(harness: Harness) -> None:
    chat = ScriptedChat(
        understand=understand_json(),
        generate=generate_json("The referral bonus is CNY 3,000 [1]."),
    )
    events = Events()
    result = await harness.ask(
        await harness.runtime(chat, StubRetrieval(GOOD)), "bonus?", on_event=events
    )
    assert events.names[0] == "run.started" and events.names[-1] == "run.ended"
    assert events.names.count("message.delta") > 3  # it really arrived in pieces
    assert "message.retract" not in events.names
    assert events.shown() == result.content == "The referral bonus is CNY 3,000 [1]."
    assert events.items[-1][1]["end_state"] == "answered"
    assert "citations" in events.names


async def test_text_is_not_shown_when_the_excerpts_are_insufficient(harness: Harness) -> None:
    chat = ScriptedChat(
        understand=understand_json(),
        rewrite='{"query": "other words"}',
        generate=generate_json("I guess it is 5 days.", sufficient=False, citations=[]),
    )
    events = Events()
    result = await harness.ask(
        await harness.runtime(chat, StubRetrieval(GOOD)), "bonus?", on_event=events
    )
    assert result.end_state == "not_found"
    assert "5 days" not in events.shown()
    assert events.shown() == result.content == messages.NOT_FOUND


async def test_a_streamed_draft_that_fails_verification_is_taken_back(harness: Harness) -> None:
    chat = ScriptedChat(
        understand=understand_json(),
        generate=[
            generate_json("Bonus is 3,000 [9].", citations=[9]),  # cites a source that is not there
            generate_json("Bonus is 3,000 [1]."),
        ],
    )
    events = Events()
    result = await harness.ask(
        await harness.runtime(chat, StubRetrieval(GOOD)), "bonus?", on_event=events
    )
    assert result.end_state == "answered"
    assert events.names.count("message.retract") == 1
    assert events.names.index("message.retract") < len(events.names) - 1
    assert events.shown() == result.content == "Bonus is 3,000 [1]."


async def test_fixed_texts_go_out_as_one_piece(harness: Harness) -> None:
    chat = ScriptedChat(understand=understand_json("chitchat", "hello"))
    events = Events()
    await harness.ask(await harness.runtime(chat, StubRetrieval(GOOD)), "Hi", on_event=events)
    assert events.names == ["run.started", "message.delta", "run.ended"]
    assert events.shown() == messages.CHITCHAT


async def test_a_dropped_model_connection_ends_the_run_as_an_error(harness: Harness) -> None:
    chat = ScriptedChat(understand=understand_json(), generate=generate_json("A long answer [1]."))
    chat.fail_stream_after["generate"] = 10
    events = Events()
    result = await harness.ask(
        await harness.runtime(chat, StubRetrieval(GOOD)), "bonus?", on_event=events
    )
    assert result.end_state == "error"
    assert events.names[-1] == "run.ended" and events.shown() == result.content
