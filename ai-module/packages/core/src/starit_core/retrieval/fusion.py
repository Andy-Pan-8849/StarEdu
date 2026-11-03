"""Reciprocal rank fusion."""

from collections.abc import Sequence
from uuid import UUID


def rrf(rankings: Sequence[Sequence[UUID]], k: int = 60) -> dict[UUID, float]:
    """score(item) = sum over lists of 1 / (k + rank), rank starting at 1.

    An item that is missing from a list gets nothing from it; items that appear high in several
    lists come out on top.
    """
    scores: dict[UUID, float] = {}
    for ranking in rankings:
        for position, item in enumerate(ranking, start=1):
            scores[item] = scores.get(item, 0.0) + 1.0 / (k + position)
    return scores
