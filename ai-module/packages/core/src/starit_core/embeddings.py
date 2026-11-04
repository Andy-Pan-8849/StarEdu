"""Turning text into vectors.

The rest of the code depends on `EmbeddingClient` only. The provider, model and dimensions are
settings, so another model is a configuration change followed by re-ingesting the documents.
"""

import hashlib
import math
from collections.abc import Sequence
from typing import Any, Protocol

from starit_core import telemetry
from starit_core.config import Settings
from starit_core.cost import DailyBudget, call_cost_usd
from starit_core.ingest.errors import IngestError


class EmbeddingClient(Protocol):
    model: str
    dimensions: int

    async def embed(self, texts: Sequence[str]) -> list[list[float]]: ...


class LiteLLMEmbeddingClient:
    """Calls a hosted embedding model through the litellm library."""

    def __init__(
        self,
        provider: str,
        model: str,
        dimensions: int,
        gateway_url: str | None = None,
        gateway_key: str = "",
        budget: DailyBudget | None = None,
    ) -> None:
        self._budget = budget
        self.provider = provider
        self.model = model
        self.dimensions = dimensions
        self._gateway_url = gateway_url
        self._gateway_key = gateway_key

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        import litellm  # imported here: it is slow to import and not needed by every caller

        model = f"{self.provider}/{self.model}"
        gateway: dict[str, str] = {}
        if self._gateway_url:
            # Same convention as the chat client: the gateway sees "<provider>/<model>".
            model = f"openai/{model}"
            gateway = {"api_base": self._gateway_url, "api_key": self._gateway_key}
        try:
            response = await litellm.aembedding(
                model=model,
                input=list(texts),
                dimensions=self.dimensions,
                num_retries=2,
                **gateway,
            )
        except Exception as exc:
            raise IngestError("embed", "embedding_failed", f"{type(exc).__name__}: {exc}") from exc
        await self._record(response, model)
        vectors = [list(item["embedding"]) for item in response.data]
        if len(vectors) != len(texts):
            raise IngestError(
                "embed", "embedding_failed", f"asked for {len(texts)} vectors, got {len(vectors)}"
            )
        for vector in vectors:
            if len(vector) != self.dimensions:
                raise IngestError(
                    "embed",
                    "dimension_mismatch",
                    f"model returned {len(vector)} dimensions, expected {self.dimensions}",
                    retryable=False,
                )
        return vectors

    async def _record(self, response: Any, model: str) -> None:
        usage = getattr(response, "usage", None)
        tokens = int(getattr(usage, "total_tokens", 0) or getattr(usage, "prompt_tokens", 0) or 0)
        if not tokens:
            return
        cost = call_cost_usd(f"{self.provider}/{self.model}", tokens)
        telemetry.current().llm_cost.add(cost, {"model": self.model})
        if self._budget is not None:
            await self._budget.add(cost)


class FakeEmbeddingClient:
    """Deterministic vectors derived from a hash of the text. For tests: it costs nothing and has
    no meaning, so similar texts are not close."""

    def __init__(self, dimensions: int = 1536, model: str = "fake-embedding") -> None:
        self.model = model
        self.dimensions = dimensions

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [self._vector(text) for text in texts]

    def _vector(self, text: str) -> list[float]:
        values: list[float] = []
        counter = 0
        while len(values) < self.dimensions:
            digest = hashlib.sha256(f"{counter}:{text}".encode()).digest()
            values.extend((b - 127.5) / 127.5 for b in digest)
            counter += 1
        values = values[: self.dimensions]
        norm = math.sqrt(sum(v * v for v in values)) or 1.0
        return [v / norm for v in values]


def vector_literal(vector: Sequence[float]) -> str:
    """A vector in pgvector's text form, for use in a CAST(... AS vector)."""
    return "[" + ",".join(repr(float(x)) for x in vector) + "]"


def embedding_client(settings: Settings, budget: DailyBudget | None = None) -> EmbeddingClient:
    if settings.embedding_provider == "fake":
        return FakeEmbeddingClient(settings.embedding_dimensions)
    proxy = settings.llm_gateway == "litellm_proxy"
    return LiteLLMEmbeddingClient(
        settings.embedding_provider,
        settings.embedding_model,
        settings.embedding_dimensions,
        settings.llm_gateway_url if proxy else None,
        settings.llm_gateway_key if proxy else "",
        budget,
    )
