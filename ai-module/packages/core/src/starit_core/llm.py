"""A minimal chat-model client: send messages, get text back.

Milestone M5 extends this with streaming and tool calls. For now it serves the reranker, which
only needs one short answer per call.
"""

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol


class ChatError(Exception):
    """The model call failed (network, rate limit, bad request)."""


@dataclass(frozen=True)
class ChatResult:
    text: str
    input_tokens: int = 0
    output_tokens: int = 0


class ChatClient(Protocol):
    async def complete(
        self,
        messages: Sequence[Mapping[str, str]],
        *,
        model: str,
        json_mode: bool = False,
        max_tokens: int | None = None,
    ) -> ChatResult: ...


class LiteLLMChatClient:
    """Calls a hosted chat model through the litellm library."""

    async def complete(
        self,
        messages: Sequence[Mapping[str, str]],
        *,
        model: str,
        json_mode: bool = False,
        max_tokens: int | None = None,
    ) -> ChatResult:
        import litellm  # imported here: it is slow to import

        options: dict[str, Any] = {
            "temperature": 0,
            # Models that reason by default spend tokens (and money) thinking; this task does
            # not need it. Models without the setting simply ignore it (drop_params).
            "reasoning_effort": "none",
            "drop_params": True,
            "num_retries": 2,
        }
        if json_mode:
            options["response_format"] = {"type": "json_object"}
        if max_tokens is not None:
            options["max_tokens"] = max_tokens
        try:
            response = await litellm.acompletion(
                model=model, messages=[dict(m) for m in messages], **options
            )
        except Exception as exc:
            raise ChatError(f"{type(exc).__name__}: {exc}") from exc
        usage = response.usage
        return ChatResult(
            text=response.choices[0].message.content or "",
            input_tokens=getattr(usage, "prompt_tokens", 0) or 0,
            output_tokens=getattr(usage, "completion_tokens", 0) or 0,
        )


class FakeChatClient:
    """For tests: answers from a function or a list, and remembers what it was asked."""

    def __init__(
        self, answer: Callable[[Sequence[Mapping[str, str]]], str] | Sequence[str]
    ) -> None:
        self._answer = answer
        self.calls: list[list[dict[str, str]]] = []

    async def complete(
        self,
        messages: Sequence[Mapping[str, str]],
        *,
        model: str,
        json_mode: bool = False,
        max_tokens: int | None = None,
    ) -> ChatResult:
        self.calls.append([dict(m) for m in messages])
        if callable(self._answer):
            text = self._answer(messages)
        else:
            text = self._answer[min(len(self.calls), len(self._answer)) - 1]
        return ChatResult(
            text=text,
            input_tokens=sum(len(m["content"]) // 4 for m in messages),
            output_tokens=len(text) // 4,
        )
