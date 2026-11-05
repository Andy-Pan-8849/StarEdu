"""文件：embeddings.py
作用：把文本变成向量（嵌入）。
主要思想：其余代码只依赖 `EmbeddingClient` 接口；提供方、模型、维度都是配置项，
换模型只需改配置再重新入库。向量维度要和数据库列（1536）一致，不一致立即报错而不是写入脏数据。
测试用 FakeEmbeddingClient：用文本哈希生成确定的向量，免费但没有语义。
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
    """嵌入客户端接口：model、dimensions 属性，和 embed(文本列表) -> 向量列表。"""

    model: str
    dimensions: int

    async def embed(self, texts: Sequence[str]) -> list[list[float]]: ...


class LiteLLMEmbeddingClient:
    """通过 litellm 调用嵌入模型（可经网关），并把费用记入指标和每日预算。"""

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
        """为一批文本生成向量。

        参数：texts——要嵌入的文本列表。
        返回：与输入等长的向量列表。
        异常：调用失败或数量不符抛 IngestError(embedding_failed)；
        维度与配置不符抛 IngestError(dimension_mismatch)，且不可重试。
        """
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
        """记录这次嵌入的费用：写指标，并累加到每日预算。"""
        usage = getattr(response, "usage", None)
        tokens = int(getattr(usage, "total_tokens", 0) or getattr(usage, "prompt_tokens", 0) or 0)
        if not tokens:
            return
        cost = call_cost_usd(f"{self.provider}/{self.model}", tokens)
        telemetry.current().llm_cost.add(cost, {"model": self.model})
        if self._budget is not None:
            await self._budget.add(cost)


class FakeEmbeddingClient:
    """测试用：向量由文本的 SHA-256 哈希确定生成并归一化，不花钱、无语义（相似文本也不接近）。"""

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
    """把向量转成 pgvector 的文本形式 [x,y,...]，用于 CAST(... AS vector)。"""
    return "[" + ",".join(repr(float(x)) for x in vector) + "]"


def embedding_client(settings: Settings, budget: DailyBudget | None = None) -> EmbeddingClient:
    """按配置创建嵌入客户端：provider 为 fake 用假实现，否则用 litellm（可经网关）。"""
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
