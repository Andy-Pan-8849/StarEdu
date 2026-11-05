"""文件：retrieval/probe.py
作用：统计“有多少强相关的内容被权限挡住了”，只返回数字。
主要思想：这是唯一一处不带权限过滤的检索，所以刻意收得很窄——只问数据库每个靠前的命中
是否允许当前用户读取，只返回个数和最高分，绝不返回文本、标题或编号，
结果也不能放进提示词或展示给用户。用途：写审计日志，以及决定回答
“没有权限”还是“没找到”（见 docs/design/04-agent-flow.md 第 5.1 节；两者对用户用同一句话）。
"""

from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncConnection

from starit_core.auth import Identity
from starit_core.permissions import chunk_access_clause
from starit_core.retrieval.keyword import keyword_statement
from starit_core.retrieval.vector import vector_statement

PROBE_KEYWORD_K = 10
PROBE_VECTOR_K = 5


@dataclass(frozen=True)
class ProbeResult:
    """被挡住的命中统计：命中个数、最高关键词得分、最高向量相似度。全是数字。"""

    restricted_keyword_hits: int
    restricted_best_keyword_score: float | None
    restricted_best_vector_similarity: float | None


async def probe_restricted(
    conn: AsyncConnection,
    identity: Identity,
    query: str,
    query_vector: Sequence[float] | None,
    model: str,
) -> ProbeResult:
    """统计被权限挡住的强相关内容。

    参数：
      conn：数据库连接；identity：提问者；query：问题；
      query_vector：问题的向量（None 则跳过向量部分）；model：嵌入模型名。
    返回：ProbeResult。
    """
    allowed = chunk_access_clause(identity).label("allowed")

    # 关键词部分：取前 10 条不过滤的命中，数一数其中不允许读取的
    hits = 0
    best_keyword: float | None = None
    keyword = keyword_statement(query, PROBE_KEYWORD_K, None).add_columns(allowed)
    for row in (await conn.execute(keyword)).mappings():
        if not row["allowed"]:
            hits += 1
            best_keyword = max(best_keyword or 0.0, float(row["score"]))

    # 向量部分：同理，只记录不允许读取的命中里最高的相似度
    best_vector: float | None = None
    if query_vector is not None:
        vector = vector_statement(query_vector, model, PROBE_VECTOR_K, None).add_columns(allowed)
        for row in (await conn.execute(vector)).mappings():
            if not row["allowed"]:
                best_vector = max(best_vector or -1.0, 1.0 - float(row["distance"]))
    return ProbeResult(hits, best_keyword, best_vector)
