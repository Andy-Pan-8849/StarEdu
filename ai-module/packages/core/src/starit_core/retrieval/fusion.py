"""文件：retrieval/fusion.py
作用：把多份排名合成一份（倒数排名融合，Reciprocal Rank Fusion，RRF）。
主要思想：关键词检索和向量检索的分数量纲不同，不能直接相加；RRF 只看名次，
每份排名里的第 r 名得 1/(k+r) 分，各份相加。在多份排名里都靠前的文本块得分最高。
k 越大，名次靠后的项目影响越大；常用值 60。
"""

from collections.abc import Sequence
from uuid import UUID


def rrf(rankings: Sequence[Sequence[UUID]], k: int = 60) -> dict[UUID, float]:
    """倒数排名融合。

    参数：
      rankings：若干份排名，每份是按相关度从高到低排好的文本块 ID 列表。
      k：平滑常数，默认 60。
    返回：{文本块ID: 融合分数}。某份排名里没有的项目，在那份里得 0 分。
    """
    scores: dict[UUID, float] = {}
    for ranking in rankings:
        for position, item in enumerate(ranking, start=1):
            scores[item] = scores.get(item, 0.0) + 1.0 / (k + position)
    return scores
