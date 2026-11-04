"""M9 real checks (a few cents): streaming through the gateway, the fallback chain, Haiku."""

import asyncio
import json
import sys

from starit_core.config import Settings
from starit_core.llm import ChatError, LiteLLMChatClient

MSG = [
    {
        "role": "system",
        "content": (
            'Reply with one JSON object: {"sufficient": true, "answer": "...", "citations": []}'
        ),
    },
    {"role": "user", "content": "Write a two-sentence answer about why the sky is blue."},
]


async def show(title: str, client: LiteLLMChatClient, model: str, stream: bool = True) -> None:
    chunks: list[str] = []

    async def on_chunk(c: str) -> None:
        chunks.append(c)

    try:
        if stream:
            r = await client.stream(
                MSG, model=model, json_mode=True, max_tokens=300, on_chunk=on_chunk
            )
        else:
            r = await client.complete(MSG, model=model, json_mode=True, max_tokens=300)
        ok = isinstance(json.loads(r.text), dict)
        print(
            f"{title}: model={r.model} chunks={len(chunks)} "
            f"tokens={r.input_tokens}/{r.output_tokens} json_ok={ok}"
        )
    except (ChatError, ValueError) as exc:
        print(f"{title}: FAILED {type(exc).__name__}: {str(exc)[:300]}")


async def main() -> None:
    which = sys.argv[1]
    base = Settings(_env_file=None)
    gw = dict(gateway_url="http://localhost:4100", gateway_key="sk-starit-local-dev")
    if which == "gateway":
        c = LiteLLMChatClient(**gw, fallbacks=[])
        await show("gateway stream gpt-6-luna", c, "gpt-6-luna")
        await show("gateway stream gpt-4o-mini", c, "gpt-4o-mini")
    elif which == "fallback":
        c = LiteLLMChatClient(**gw, fallbacks=["openai/gpt-4o-mini", "anthropic/claude-haiku-5-5"])
        await show("1 bad primary -> gpt-4o-mini", c, "openai/no-such-model-a")
        c2 = LiteLLMChatClient(
            **gw, fallbacks=["openai/no-such-model-b", "anthropic/claude-haiku-5-5"]
        )
        await show("2 bad -> haiku", c2, "openai/no-such-model-a")
    elif which == "haiku":
        c = LiteLLMChatClient(**gw, fallbacks=[])
        await show("haiku direct stream", c, "anthropic/claude-haiku-5-5")
        await show("haiku direct complete", c, "anthropic/claude-haiku-5-5", stream=False)
    _ = base


asyncio.run(main())
