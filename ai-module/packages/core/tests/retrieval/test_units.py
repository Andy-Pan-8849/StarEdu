"""文件：测试——检索的各个小部件
测什么：RRF 融合（名次、空列表、k 的影响）；assemble（数量上限、token 预算、第一块总保留、去重）
  ；
重排结果解析（正常、带围栏、坏/重复/缺少的编号、完全无效）；重排提示的内容；
  重排失败时保持融合顺序；
关键词查询的构造。
"""

import dataclasses
import json
from uuid import uuid4

import pytest
from starit_core.llm import ChatError, FakeChatClient
from starit_core.retrieval.assemble import assemble
from starit_core.retrieval.fusion import rrf
from starit_core.retrieval.models import Candidate
from starit_core.retrieval.probe import ProbeResult
from starit_core.retrieval.rerank import (
    LLMReranker,
    RerankParseError,
    build_messages,
    parse_ranking,
)


def candidate(
    text: str = "text", tokens: int = 10, status: str = "active", **kw: object
) -> Candidate:
    base = {
        "chunk_id": uuid4(), "document_id": uuid4(), "doc_code": "DOC-1", "title": "A Policy",
        "version": "1.0", "status": status, "heading_path": ["1. Rules"], "page": None,
        "text": text, "token_count": tokens,
    }  # fmt: skip
    base.update(kw)
    return Candidate(**base)  # type: ignore[arg-type]


# --- fusion ---------------------------------------------------------------------------------


def test_rrf_scores_an_item_by_its_rank_in_every_list() -> None:
    a, b, c = uuid4(), uuid4(), uuid4()
    scores = rrf([[a, b], [b, c]], k=60)
    assert scores[a] == pytest.approx(1 / 61)
    assert scores[b] == pytest.approx(1 / 62 + 1 / 61)
    assert scores[c] == pytest.approx(1 / 62)
    assert max(scores, key=lambda x: scores[x]) == b  # high in both lists wins


def test_rrf_with_no_lists_or_empty_lists() -> None:
    assert rrf([]) == {}
    assert rrf([[], []]) == {}


def test_a_smaller_k_rewards_the_top_rank_more() -> None:
    a, b = uuid4(), uuid4()
    sharp = rrf([[a, b]], k=1)
    flat = rrf([[a, b]], k=100)
    assert sharp[a] / sharp[b] > flat[a] / flat[b]


# --- assembling the context -----------------------------------------------------------------


def test_assemble_stops_at_final_k() -> None:
    chosen = assemble([candidate(f"t{n}") for n in range(10)], final_k=3, budget_tokens=1000)
    assert [c.text for c in chosen] == ["t0", "t1", "t2"]


def test_assemble_respects_the_token_budget_but_always_keeps_the_first() -> None:
    items = [
        candidate("big", tokens=900),
        candidate("next", tokens=200),
        candidate("more", tokens=50),
    ]
    assert [c.text for c in assemble(items, final_k=6, budget_tokens=1000)] == ["big"]
    assert [c.text for c in assemble(items, final_k=6, budget_tokens=500)] == ["big"]


def test_assemble_skips_duplicates_by_id_and_by_text() -> None:
    first = candidate("Same   text here")
    items = [first, first, candidate("same text HERE"), candidate("different")]
    assert [c.text for c in assemble(items, final_k=6, budget_tokens=1000)] == [
        "Same   text here",
        "different",
    ]


# --- reading the model's ranking ------------------------------------------------------------


def test_parse_a_normal_ranking() -> None:
    text = json.dumps(
        {"ranking": [{"id": 3, "score": 9}, {"id": 1, "score": 4}, {"id": 2, "score": 0}]}
    )
    order, scores, partial = parse_ranking(text, 3)
    assert order == [2, 0, 1]
    assert scores == {2: 9.0, 0: 4.0, 1: 0.0}
    assert partial is False


def test_parse_accepts_code_fences_a_bare_list_and_numeric_strings() -> None:
    assert parse_ranking('```json\n{"ranking": [{"id": 2}, {"id": 1}]}\n```', 2)[0] == [1, 0]
    assert parse_ranking("[2, 1]", 2)[0] == [1, 0]
    assert parse_ranking('{"ranking": [{"id": "2", "score": "7"}, {"id": "1"}]}', 2)[:2] == (
        [1, 0],
        {},  # a score that is not a number is ignored
    )


def test_parse_ignores_bad_and_repeated_ids_and_appends_missing_ones() -> None:
    text = json.dumps(
        {"ranking": [{"id": 4}, {"id": 9}, {"id": 0}, {"id": 4}, {"id": "x"}, {"id": True}]}
    )
    order, _scores, partial = parse_ranking(text, 4)
    assert order == [3, 0, 1, 2]  # id 4 first, then the ones it left out in original order
    assert partial is True


@pytest.mark.parametrize(
    "text",
    [
        "",
        "not json",
        '{"ranking": "none"}',
        '{"other": 1}',
        '{"ranking": []}',
        '{"ranking": [{"id": 99}]}',
        "42",
    ],
)
def test_parse_rejects_answers_with_no_usable_ranking(text: str) -> None:
    with pytest.raises(RerankParseError):
        parse_ranking(text, 3)


def test_the_prompt_names_each_passage_with_its_version_status_and_path() -> None:
    old = candidate("old rule", status="superseded", version="1.0", doc_code="HR-REC-001")
    new = candidate("new rule " * 400, version="2.1", doc_code="HR-REC-001")
    messages = build_messages("what is the bonus?", [old, new], passage_tokens=20)
    assert messages[0]["role"] == "system" and "JSON" in messages[0]["content"]
    user = messages[1]["content"]
    assert "Question: what is the bonus?" in user
    assert "[1] HR-REC-001 v1.0 (superseded)" in user and "[2] HR-REC-001 v2.1 (active)" in user
    assert "1. Rules" in user
    assert user.count("new rule") < 400  # long passages are cut


async def test_rerank_applies_the_models_order() -> None:
    items = [candidate("a"), candidate("b"), candidate("c")]
    client = FakeChatClient(
        ['{"ranking": [{"id": 3, "score": 10}, {"id": 1, "score": 5}, {"id": 2, "score": 1}]}']
    )
    outcome = await LLMReranker(client, "m").rerank("q", items)
    assert outcome.order == [2, 0, 1]
    assert outcome.scores[2] == 10.0 and not outcome.failed
    assert len(client.calls) == 1


@pytest.mark.parametrize("answer", ["I think passage 2 is best.", '{"ranking": []}', "```"])
async def test_rerank_keeps_the_fused_order_when_the_answer_is_unusable(answer: str) -> None:
    outcome = await LLMReranker(FakeChatClient([answer]), "m").rerank(
        "q", [candidate("a"), candidate("b")]
    )
    assert outcome.order == [0, 1] and outcome.failed and outcome.error


async def test_rerank_keeps_the_fused_order_when_the_model_call_fails() -> None:
    class Down:
        async def complete(self, *_a: object, **_k: object) -> object:
            raise ChatError("rate limited")

    outcome = await LLMReranker(Down(), "m").rerank("q", [candidate("a"), candidate("b")])  # type: ignore[arg-type]
    assert outcome.order == [0, 1] and outcome.failed and "rate limited" in (outcome.error or "")


async def test_rerank_does_not_call_the_model_for_fewer_than_two_candidates() -> None:
    client = FakeChatClient(["{}"])
    assert (await LLMReranker(client, "m").rerank("q", [candidate("a")])).order == [0]
    assert (await LLMReranker(client, "m").rerank("q", [])).order == []
    assert client.calls == []


# --- the probe ------------------------------------------------------------------------------


def test_the_probe_result_holds_only_numbers() -> None:
    result = ProbeResult(
        restricted_keyword_hits=3,
        restricted_best_keyword_score=1.2,
        restricted_best_vector_similarity=None,
    )
    for value in dataclasses.asdict(result).values():
        assert value is None or isinstance(value, int | float)
    for annotation in (f.type for f in dataclasses.fields(ProbeResult)):
        assert "str" not in str(annotation)


# --- regressions found by the live check -----------------------------------------------------


def test_the_default_rerank_limit_shows_a_whole_chunk() -> None:
    """A passage cut shorter than a chunk hides its end. The answer to ERR-PORTAL-429 sat at token
    365 of its chunk, which a 350-token cut hid; the model then scored it 2 out of 10."""
    from starit_core.config import Settings
    from starit_core.ingest.tokens import count_tokens

    settings = Settings(_env_file=None)
    assert settings.rerank_passage_tokens >= settings.chunk_max_tokens

    filler = "Courseware downloads are limited per month. " * 45  # 361 tokens
    tail = "ERR-PORTAL-429 | Download quota used up | Wait for the 1st of the month"
    chunk = candidate(text=filler + tail)
    assert 350 < count_tokens(filler) < settings.chunk_max_tokens  # the tail is past the old cut
    user = build_messages(
        "What does ERR-PORTAL-429 mean?", [chunk, candidate()], settings.rerank_passage_tokens
    )[1]["content"]
    assert "Download quota used up" in user
    # ...and the old limit really would have hidden it, so this test fails if the limit is lowered.
    cut = build_messages("What does ERR-PORTAL-429 mean?", [chunk, candidate()], 350)[1]["content"]
    assert "Download quota used up" not in cut


def test_the_understanding_prompt_keeps_technical_support_in_scope() -> None:
    """Slow Maven downloads were once refused as out of scope."""
    from starit_core.agent.prompts import prompt_text

    prompt = prompt_text("understand")
    assert "Maven" in prompt and "is NOT out of scope" in prompt
    assert "learning portal" in prompt and "loaner laptops" in prompt
