"""文件：metrics.py
作用：检索评测指标，全是纯函数。
指标含义：检索结果按名次返回文档；“命中”指问题的来源文档之一出现在前 k 个**文档**里
（同一文档的多个块只算一个）。
  - hit@k：前 k 个文档里有来源文档的题所占比例；
  - recall@k：来源文档被找回的比例；
  - MRR（平均倒数排名）：来源文档第一次出现的名次的倒数，再对所有题取平均。
"""

import math
from collections import defaultdict
from collections.abc import Collection, Iterable, Sequence
from dataclasses import dataclass


def unique_in_order(doc_codes: Iterable[str]) -> list[str]:
    """去重但保持第一次出现的顺序（把块名次换算成文档名次）。"""
    seen: dict[str, None] = {}
    for code in doc_codes:
        seen.setdefault(code, None)
    return list(seen)


def hit_at_k(doc_codes: Sequence[str], sources: Collection[str], k: int) -> bool:
    """前 k 个文档里是否有来源文档。"""
    return bool(set(unique_in_order(doc_codes)[:k]) & set(sources))


def recall_at_k(doc_codes: Sequence[str], sources: Collection[str], k: int) -> float:
    """前 k 个文档找回了多少比例的来源文档；没有来源返回 0。"""
    if not sources:
        return 0.0
    return len(set(unique_in_order(doc_codes)[:k]) & set(sources)) / len(set(sources))


def reciprocal_rank(doc_codes: Sequence[str], sources: Collection[str]) -> float:
    """第一个来源文档名次的倒数；没出现返回 0。"""
    for rank, code in enumerate(unique_in_order(doc_codes), start=1):
        if code in sources:
            return 1.0 / rank
    return 0.0


def percentile(values: Sequence[float], p: float) -> float:
    """最近名次法的百分位数（p50、p95 等）；没有数据返回 0。"""
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[max(0, math.ceil(p / 100 * len(ordered)) - 1)]


@dataclass(frozen=True)
class Scored:
    """一道可回答题的检索结果：题型、返回的文档编号（按名次）、来源文档。"""

    type: str
    doc_codes: tuple[str, ...]
    sources: tuple[str, ...]


@dataclass(frozen=True)
class Summary:
    """一组题的汇总：题数、hit@1/3/6、recall@6、MRR。"""

    n: int
    hit1: float
    hit3: float
    hit6: float
    recall6: float
    mrr: float


def summarize(items: Sequence[Scored]) -> Summary:
    """汇总一组结果，取各项指标的平均。"""
    n = len(items)
    if n == 0:
        return Summary(0, 0.0, 0.0, 0.0, 0.0, 0.0)

    def mean(values: Iterable[float]) -> float:
        return sum(values) / n

    return Summary(
        n=n,
        hit1=mean(hit_at_k(i.doc_codes, i.sources, 1) for i in items),
        hit3=mean(hit_at_k(i.doc_codes, i.sources, 3) for i in items),
        hit6=mean(hit_at_k(i.doc_codes, i.sources, 6) for i in items),
        recall6=mean(recall_at_k(i.doc_codes, i.sources, 6) for i in items),
        mrr=mean(reciprocal_rank(i.doc_codes, i.sources) for i in items),
    )


def summarize_by_type(items: Sequence[Scored]) -> dict[str, Summary]:
    """按题型分组汇总，便于看哪类题弱。"""
    groups: dict[str, list[Scored]] = defaultdict(list)
    for item in items:
        groups[item.type].append(item)
    return {kind: summarize(group) for kind, group in sorted(groups.items())}
