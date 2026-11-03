"""List prices, USD per million tokens, for the cost estimate.

Found on 2026-11-03 in third-party price lists; OpenAI's own pricing page was not read, so treat
the figures as estimates. A model that is not listed has an unknown cost.
"""

PRICES_PER_MILLION: dict[str, tuple[float, float]] = {  # (input, output)
    "text-embedding-3-small": (0.02, 0.0),
    "gpt-6-luna": (0.10, 0.50),
}


def cost_usd(model: str, input_tokens: int, output_tokens: int = 0) -> float | None:
    name = model.split("/", 1)[-1]
    if name not in PRICES_PER_MILLION:
        return None
    price_in, price_out = PRICES_PER_MILLION[name]
    return (input_tokens * price_in + output_tokens * price_out) / 1_000_000
