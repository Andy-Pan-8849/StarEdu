from typing import Any, cast

import pytest
from starit_core.agent.graph import END_NODES, ROUTES, build_graph
from starit_core.agent.nodes import AgentNodes, BudgetedChat
from starit_core.agent.state import RunTotals
from starit_core.config import Settings
from starit_core.embeddings import FakeEmbeddingClient
from starit_core.llm import ChatResult


def compiled() -> Any:
    nodes = AgentNodes(
        engine=cast(Any, None), settings=Settings(_env_file=None), embedder=FakeEmbeddingClient()
    )
    return build_graph(nodes)


def edges_of(graph: Any) -> dict[str, set[str]]:
    drawn = graph.get_graph()
    out: dict[str, set[str]] = {node: set() for node in drawn.nodes}
    for edge in drawn.edges:
        out[edge.source].add(edge.target)
    return out


def reachable(edges: dict[str, set[str]], start: str) -> set[str]:
    seen, stack = set(), [start]
    while stack:
        node = stack.pop()
        if node not in seen:
            seen.add(node)
            stack.extend(edges.get(node, ()))
    return seen


def test_every_step_can_reach_an_end_step() -> None:
    edges = edges_of(compiled())
    assert "__end__" in edges
    for node in edges:
        if node in ("__end__",):
            continue
        assert "__end__" in reachable(edges, node), f"{node} is a dead end"
        if node != "__start__":
            assert reachable(edges, node) & set(END_NODES), f"{node} never reaches an end step"


def test_the_end_steps_are_the_six_end_states() -> None:
    assert [n.removeprefix("end_") for n in END_NODES] == [
        "answered",
        "need_clarification",
        "no_permission",
        "not_found",
        "refused",
        "error",
    ]


def test_the_drawn_graph_matches_the_routes_that_are_documented() -> None:
    edges = edges_of(compiled())
    for step, targets in ROUTES.items():
        assert edges[step] == {*targets, "end_error"}, step
    for end in END_NODES:
        assert edges[end] == {"__end__"}
    assert edges["__start__"] == {"load_context"}
    # Every step is reachable from the start.
    assert set(edges) - {"__start__"} <= reachable(edges, "__start__")


def test_the_graph_can_be_drawn_for_the_documentation() -> None:
    diagram = compiled().get_graph().draw_mermaid()
    assert "load_context" in diagram and "end_error" in diagram


class _Inner:
    def __init__(self) -> None:
        self.models: list[str] = []

    async def complete(self, messages: Any, *, model: str, **_kw: Any) -> ChatResult:
        self.models.append(model)
        return ChatResult("ok", input_tokens=10, output_tokens=2)


async def test_the_chat_budget_counts_calls_and_tokens_and_stops_at_the_limit() -> None:
    totals = RunTotals()
    chat = BudgetedChat(_Inner(), totals, limit=2, request_timeout=5)
    await chat.complete([{"role": "user", "content": "a"}], model="m1")
    await chat.complete([{"role": "user", "content": "b"}], model="m2")
    assert (totals.llm_calls, totals.input_tokens, totals.output_tokens) == (2, 20, 4)
    assert totals.models == ["m1", "m2"]
    from starit_core.agent.nodes import AgentFailure

    with pytest.raises(AgentFailure) as caught:
        await chat.complete([{"role": "user", "content": "c"}], model="m1")
    assert caught.value.reason == "step_limit"
    assert totals.llm_calls == 2
