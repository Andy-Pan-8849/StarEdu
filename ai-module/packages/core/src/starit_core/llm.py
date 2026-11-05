"""文件：llm.py
作用：聊天模型客户端——发消息、收文字（可选流式）。
主要思想：
  - 上层只依赖 `ChatClient` 接口，不关心背后是 litellm 库直连还是 LiteLLM 网关。
  - 走网关时，网关地址和密钥由配置给出，厂商密钥只在网关容器里。
  - 备用链(fallbacks)：主模型出错（网络、限流、模型不存在等，不是“答得不好”）时按顺序换下一个模型。
  - 统一返回 ChatResult，带实际作答的模型名，便于发现备用链触发并正确计费。
"""

import json
import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from starit_core.config import Settings
from starit_core.ingest.tokens import count_tokens


class ChatError(Exception):
    """模型调用失败（网络、限流、请求错误），或模型的回答无法按要求解析。"""


@dataclass(frozen=True)
class ChatResult:
    """一次模型调用的结果：文字、输入/输出 token，
    以及实际作答的模型（备用链触发后与请求的模型不同）。
    """

    text: str
    input_tokens: int = 0
    output_tokens: int = 0
    model: str = (
        ""  # the model that answered, which differs from the one asked for after a fallback
    )


class ChatClient(Protocol):
    """聊天客户端接口：complete 一次拿完整结果。真实实现与测试替身都满足它。"""

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
    """通过 litellm 调用聊天模型；给了 gateway_url 就改走 LiteLLM 网关（密钥在网关，不在本进程）。
    fallbacks 是出错时依次尝试的备用模型。
    """

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
        """组装 litellm 的请求参数。

        参数：messages 消息；model 模型名；json_mode 是否要求返回 JSON；
          max_tokens 输出上限；request_timeout 单次请求超时（秒）。
        返回：可直接传给 litellm.acompletion 的字典。
        """
        options: dict[str, Any] = {
            # 温度 0：要尽量可复现的输出（评测、校验都依赖这一点）
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
            # 走网关：加 openai/ 前缀让库用 OpenAI 协议与网关通信，网关收到的是配置里的原模型名
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
        """发起一次非流式调用，返回 ChatResult；任何失败统一包装成 ChatError。"""
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
        """流式调用：每收到一段文字就调用 on_chunk。
        已经交付过部分文字后再出错，仍抛 ChatError，如何处理这部分文字由调用方决定。
        供应商没返回用量时按文字估算 token，避免把这次调用记成免费。
        """
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
    """把逗号分隔的备用模型配置拆成列表，忽略空项。"""
    return [m.strip() for m in value.split(",") if m.strip()]


def chat_client(settings: Settings) -> ChatClient:
    """按配置创建聊天客户端：litellm_proxy 走网关，否则直连。"""
    fallbacks = parse_fallbacks(settings.llm_fallbacks)
    if settings.llm_gateway == "litellm_proxy":
        return LiteLLMChatClient(settings.llm_gateway_url, settings.llm_gateway_key, fallbacks)
    return LiteLLMChatClient(fallbacks=fallbacks)


class FakeChatClient:
    """测试替身：按函数或列表回答，并记录收到的请求。"""

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
    """把模型的回答解析成一个 JSON 对象（容忍 ```json 围栏）；不是对象则抛 ChatError。"""
    try:
        data = json.loads(_FENCE.sub("", text.strip()))
    except json.JSONDecodeError as exc:
        raise ChatError(f"the answer is not valid JSON: {exc.msg}") from exc
    if not isinstance(data, dict):
        raise ChatError("the answer is not a JSON object")
    return data
