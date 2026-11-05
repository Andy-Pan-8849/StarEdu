"""文件：pricing.py
作用：评测前估算费用用的价目表（每百万 token 的美元价）。
说明：价格来自第三方价目表(2026-11-03)，没有读 OpenAI 官网，只能当估算；
表里没有的模型费用未知（返回 None）。真正的计费以 LiteLLM 价目表为准（见 starit_core/cost.py）。
"""

PRICES_PER_MILLION: dict[str, tuple[float, float]] = {  # (input, output)
    "text-embedding-3-small": (0.02, 0.0),
    "gpt-6-luna": (0.10, 0.50),
    # From memory, not re-checked in this project: confirm before relying on the estimate.
    "gpt-4o-mini": (0.15, 0.60),
}


def cost_usd(model: str, input_tokens: int, output_tokens: int = 0) -> float | None:
    """估算一次调用的美元费用；模型不在价目表里返回 None。参数：model 模型名；
    input_tokens/output_tokens。
    """
    name = model.split("/", 1)[-1]
    if name not in PRICES_PER_MILLION:
        return None
    price_in, price_out = PRICES_PER_MILLION[name]
    return (input_tokens * price_in + output_tokens * price_out) / 1_000_000
