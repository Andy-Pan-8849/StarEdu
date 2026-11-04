"""A minimal chat-model client: send messages, get text back.

Milestone M5 extends this with streaming and tool calls. For now it serves the reranker, which
only needs one short answer per call.
"""

import json
import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from starit_core.config import Settings
from starit_core.ingest.tokens import count_tokens


class ChatError(Exception):
    """The model call failed (network, rate limit, bad request)."""


@dataclass(frozen=True)
class ChatResult:
    text: str
    input_tokens: int = 0
    output_tokens: int = 0
    model: str = (
        ""  # the model that answered, which differs from the one asked for after a fallback
    )


class ChatClient(Protocol):
    async def complete(
        self,
        messages: Sequence[Mapping[str, str]],
        *,
        model: str,
        json_mode: bool = False,
        max_tokens: int | None = None,
        request_timeout: float | None = None,
    ) -> ChatResult: ...


class LiteLLMChatClient:
    """Calls a hosted chat model through the litellm library, or through the LiteLLM gateway
    when `gateway_url` is given (the gateway holds the provider keys, not this process)."""

    def __init__(
        self,
        gateway_url: str | None = None,
        gateway_key: str = "",
        fallbacks: Sequence[str] = (),
    ) -> None:
        self._gateway_url = gateway_url
        self._gateway_key = gateway_key
        self._fallbacks = list(fallbacks)

    def _request(
        self,
        messages: Sequence[Mapping[str, str]],
        model: str,
        json_mode: bool,
        max_tokens: int | None,
        request_timeout: float | None,
    ) -> dict[str, Any]:
        options: dict[str, Any] = {
            "temperature": 0,
            # Models that reason by default spend tokens (and money) thinking; this task does
            # not need it. Models without the setting simply ignore it (drop_params).
            "reasoning_effort": "none",
            "drop_params": True,
            "num_retries": 2,
            "messages": [dict(m) for m in messages],
        }
        if json_mode:
            options["response_format"] = {"type": "json_object"}
        if max_tokens is not None:
            options["max_tokens"] = max_tokens
        if request_timeout is not None:
            options["timeout"] = request_timeout
        if self._gateway_url:
            # "openai/" tells the library to speak the OpenAI protocol to the gateway; it strips
            # that prefix, so the gateway receives the model name exactly as configured.
            model = f"openai/{model}"
            options["api_base"] = self._gateway_url
            options["api_key"] = self._gateway_key
        if self._fallbacks:
            # Tried in this order if the call errors. Through the gateway each name gets the same
            # "openai/" prefix as the model above, so the gateway sees the configured names.
            via_gateway = bool(self._gateway_url)
            options["fallbacks"] = [f"openai/{m}" if via_gateway else m for m in self._fallbacks]
        options["model"] = model
        return options

    async def complete(
        self,
        messages: Sequence[Mapping[str, str]],
        *,
        model: str,
        json_mode: bool = False,
        max_tokens: int | None = None,
        request_timeout: float | None = None,
    ) -> ChatResult:
        import litellm  # imported here: it is slow to import

        request = self._request(messages, model, json_mode, max_tokens, request_timeout)
        try:
            response = await litellm.acompletion(**request)
        except Exception as exc:
            raise ChatError(f"{type(exc).__name__}: {exc}") from exc
        usage = response.usage
        return ChatResult(
            text=response.choices[0].message.content or "",
            input_tokens=getattr(usage, "prompt_tokens", 0) or 0,
            output_tokens=getattr(usage, "completion_tokens", 0) or 0,
            model=str(getattr(response, "model", "") or ""),
        )

    async def stream(
        self,
        messages: Sequence[Mapping[str, str]],
        *,
        model: str,
        json_mode: bool = False,
        max_tokens: int | None = None,
        request_timeout: float | None = None,
        on_chunk: Callable[[str], Awaitable[None]],
    ) -> ChatResult:
        """Like `complete`, but `on_chunk` gets each piece of text as it arrives. An error after
        some text was delivered is still a ChatError; the caller decides about that text."""
        import litellm

        request = self._request(messages, model, json_mode, max_tokens, request_timeout)
        parts: list[str] = []
        usage: Any = None
        answered = ""
        try:
            response = await litellm.acompletion(
                stream=True, stream_options={"include_usage": True}, **request
            )
            async for chunk in response:
                answered = str(getattr(chunk, "model", "") or answered)
                if getattr(chunk, "usage", None):
                    usage = chunk.usage
                for choice in chunk.choices or []:
                    piece = getattr(choice.delta, "content", None)
                    if piece:
                        parts.append(piece)
                        await on_chunk(piece)
        except ChatError:
            raise
        except Exception as exc:
            raise ChatError(f"{type(exc).__name__}: {exc}") from exc
        text = "".join(parts)
        if usage is not None:
            tokens_in = getattr(usage, "prompt_tokens", 0) or 0
            tokens_out = getattr(usage, "completion_tokens", 0) or 0
        else:  # the provider sent no usage: estimate, rather than count the call as free
            tokens_in = sum(count_tokens(m["content"]) for m in messages)
            tokens_out = count_tokens(text)
        return ChatResult(text, tokens_in, tokens_out, answered)


def parse_fallbacks(value: str) -> list[str]:
    return [m.strip() for m in value.split(",") if m.strip()]


def chat_client(settings: Settings) -> ChatClient:
    fallbacks = parse_fallbacks(settings.llm_fallbacks)
    if settings.llm_gateway == "litellm_proxy":
        return LiteLLMChatClient(settings.llm_gateway_url, settings.llm_gateway_key, fallbacks)
    return LiteLLMChatClient(fallbacks=fallbacks)


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
        request_timeout: float | None = None,
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


_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)


def parse_json_object(text: str) -> dict[str, Any]:
    """Read a model's answer as one JSON object (code fences tolerated)."""
    try:
        data = json.loads(_FENCE.sub("", text.strip()))
    except json.JSONDecodeError as exc:
        raise ChatError(f"the answer is not valid JSON: {exc.msg}") from exc
    if not isinstance(data, dict):
        raise ChatError("the answer is not a JSON object")
    return data
