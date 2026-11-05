"""文件：retrieval/__init__.py
作用：检索包的对外入口，只导出 `retrieve` 及其结果类型。
主要思想：混合检索 = 关键词检索 + 向量检索 -> 排名融合(RRF) -> 模型重排 -> 拼装上下文。
调用方（助手、评测）只用这里导出的名字，不直接碰包内细节。
"""

from starit_core.retrieval.models import Candidate, RetrievalDiagnostics, RetrievalResult
from starit_core.retrieval.search import MODES, retrieve

__all__ = ["MODES", "Candidate", "RetrievalDiagnostics", "RetrievalResult", "retrieve"]
