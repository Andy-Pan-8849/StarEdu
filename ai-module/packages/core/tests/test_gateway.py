"""Models are reached directly or through the LiteLLM gateway, chosen by settings."""

from types import SimpleNamespace
from typing import Any

import litellm
import pytest
from starit_core.config import Settings
from starit_core.embeddings import LiteLLMEmbeddingClient, embedding_client
from starit_core.llm import ChatError, LiteLLMChatClient, chat_client

KEY = "sk-gateway-test-key-123456"


class Recorder:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []


@pytest.fixture
def chat_calls(monkeypatch: pytest.MonkeyPatch) -> Recorder:
    recorder = Recorder()

    async def fake(**kwargs: Any) -> Any:
        recorder.calls.append(kwargs)
        message = SimpleNamespace(content="ok")
        usage = SimpleNamespace(prompt_tokens=3, completion_tokens=2)
        return SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=usage)

    monkeypatch.setattr(litellm, "acompletion", fake)
    return recorder


async def test_direct_calls_use_the_model_name_as_given(chat_calls: Recorder) -> None:
    result = await LiteLLMChatClient().complete(
        [{"role": "user", "content": "hi"}], model="openai/gpt-6-luna"
    )
    assert result.text == "ok" and result.input_tokens == 3
    call = chat_calls.calls[0]
    assert call["model"] == "openai/gpt-6-luna"
    assert "api_base" not in call and "api_key" not in call


async def test_gateway_calls_go_to_the_gateway_with_its_key(chat_calls: Recorder) -> None:
    client = LiteLLMChatClient("http://litellm:4000", KEY)
    await client.complete(
        [{"role": "user", "content": "hi"}], model="openai/gpt-6-luna", json_mode=True
    )
    call = chat_calls.calls[0]
    # The library strips the first "openai/", so the gateway receives "openai/gpt-6-luna".
    assert call["model"] == "openai/openai/gpt-6-luna"
    assert call["api_base"] == "http://litellm:4000" and call["api_key"] == KEY
    assert call["response_format"] == {"type": "json_object"}


def test_settings_choose_the_client(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("STARIT_LLM_GATEWAY", "STARIT_LLM_GATEWAY_URL", "STARIT_LLM_GATEWAY_KEY"):
        monkeypatch.delenv(name, raising=False)
    direct = chat_client(Settings(_env_file=None))
    assert direct._gateway_url is None  # type: ignore[attr-defined]
    proxied = chat_client(
        Settings(
            _env_file=None,
            llm_gateway="litellm_proxy",
            llm_gateway_url="http://g:4000",
            llm_gateway_key=KEY,
        )
    )
    assert proxied._gateway_url == "http://g:4000"  # type: ignore[attr-defined]


def test_the_gateway_key_is_not_in_the_settings_repr() -> None:
    assert KEY not in repr(Settings(_env_file=None, llm_gateway_key=KEY))


async def test_an_unreachable_gateway_is_a_chat_error_that_does_not_contain_the_key() -> None:
    client = LiteLLMChatClient("http://127.0.0.1:9", KEY)
    with pytest.raises(ChatError) as caught:
        await client.complete(
            [{"role": "user", "content": "hi"}], model="openai/gpt-6-luna", request_timeout=2
        )
    assert KEY not in str(caught.value)


async def test_embeddings_through_the_gateway(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[dict[str, Any]] = []

    async def fake(**kwargs: Any) -> Any:
        seen.append(kwargs)
        return SimpleNamespace(data=[{"embedding": [0.0] * 4}])

    monkeypatch.setattr(litellm, "aembedding", fake)
    client = LiteLLMEmbeddingClient(
        "openai", "text-embedding-3-small", 4, "http://litellm:4000", KEY
    )
    await client.embed(["x"])
    assert seen[0]["model"] == "openai/openai/text-embedding-3-small"
    assert seen[0]["api_base"] == "http://litellm:4000" and seen[0]["api_key"] == KEY
    seen.clear()
    await LiteLLMEmbeddingClient("openai", "text-embedding-3-small", 4).embed(["x"])
    assert seen[0]["model"] == "openai/text-embedding-3-small" and "api_base" not in seen[0]


def test_embedding_client_follows_the_gateway_setting() -> None:
    settings = Settings(
        _env_file=None,
        llm_gateway="litellm_proxy",
        llm_gateway_url="http://g:4000",
        llm_gateway_key=KEY,
    )
    assert embedding_client(settings)._gateway_url == "http://g:4000"  # type: ignore[attr-defined]
