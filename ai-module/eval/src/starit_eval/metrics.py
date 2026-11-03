"""Retrieval metrics. Pure functions: documents come back in rank order, and a hit means one
of the question's source documents is among the first k *documents* (several chunks of one
document count once)."""

import math
from collections import defaultdict
from collections.abc import Collection, Iterable, Sequence
from dataclasses import dataclass


def unique_in_order(doc_codes: Iterable[str]) -> list[str]:
    seen: dict[str, None] = {}
    for code in doc_codes:
        seen.setdefault(code, None)
    return list(seen)


def hit_at_k(doc_codes: Sequence[str], sources: Collection[str], k: int) -> bool:
    return bool(set(unique_in_order(doc_codes)[:k]) & set(sources))


def recall_at_k(doc_codes: Sequence[str], sources: Collection[str], k: int) -> float:
    if not sources:
        return 0.0
    return len(set(unique_in_order(doc_codes)[:k]) & set(sources)) / len(set(sources))


def reciprocal_rank(doc_codes: Sequence[str], sources: Collection[str]) -> float:
    for rank, code in enumerate(unique_in_order(doc_codes), start=1):
        if code in sources:
            return 1.0 / rank
    return 0.0


def percentile(values: Sequence[float], p: float) -> float:
    """Nearest-rank percentile; 0 for no values."""
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[max(0, math.ceil(p / 100 * len(ordered)) - 1)]


@dataclass(frozen=True)
class Scored:
    """What the metrics need to know about one answerable question's search."""

    type: str
    doc_codes: tuple[str, ...]
    sources: tuple[str, ...]


@dataclass(frozen=True)
class Summary:
    n: int
    hit1: float
    hit3: float
    hit6: float
    recall6: float
    mrr: float


def summarize(items: Sequence[Scored]) -> Summary:
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
    groups: dict[str, list[Scored]] = defaultdict(list)
    for item in items:
        groups[item.type].append(item)
    return {kind: summarize(group) for kind, group in sorted(groups.items())}
