"""文件：scripts/m9_real_check.py
作用：M9 的真实调用检查（总共几美分）：经网关的流式、备用链、Haiku 直连。
用法：uv run python scripts/m9_real_check.py gateway|fallback|haiku
  - gateway：经 LiteLLM 网关流式调用 gpt-6-luna 和 gpt-4o-mini；
  - fallback：主模型无效时应由 gpt-4o-mini 作答；前两级都无效时应由 claude-haiku 作答；
  - haiku：直连 Haiku，流式和非流式各一次。
每行输出：实际作答的模型、收到几块、token 数、返回的是不是合法 JSON。
会产生真实费用，运行前要确认。
"""

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
    """调用一次并打印结果摘要；失败打印错误类型和前 300 字，不抛异常。"""
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
    """按命令行参数选择要做的检查。"""
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
