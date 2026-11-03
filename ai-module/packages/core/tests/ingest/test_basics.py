import pytest
from starit_core.embeddings import FakeEmbeddingClient, LiteLLMEmbeddingClient, vector_literal
from starit_core.ingest.clean import clean_document, clean_text
from starit_core.ingest.errors import IngestError
from starit_core.ingest.identifiers import extract_identifiers
from starit_core.ingest.models import Block, Chunk, ParsedDocument
from starit_core.ingest.pipeline import embedding_input
from starit_core.ingest.tokens import count_tokens


def test_token_counts_are_positive_and_grow_with_text() -> None:
    assert count_tokens("") == 0
    assert (
        0 < count_tokens("ERR-PORTAL-403") < count_tokens("ERR-PORTAL-403 means the device limit")
    )
    assert count_tokens("<|endoftext|>") > 0  # special-token text is counted, not rejected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("What does ERR-PORTAL-403 mean?", ["ERR-PORTAL-403"]),
        ("ERR-PORTAL-429 and ERR-PORTAL-403", ["ERR-PORTAL-429", "ERR-PORTAL-403"]),
        ("See TS-NET-009 and FIN-REIM-002.", ["TS-NET-009", "FIN-REIM-002"]),
        ("Tax ID: 91510000FAKE00001X (fictional)", ["91510000FAKE00001X"]),
        ("The STC-2 stage", ["STC-2"]),
        ("An e-mail and a well-known fact", []),
        ("A sentence about CNY 2,000 in 2026-01-01", []),
    ],
)
def test_identifiers(text: str, expected: list[str]) -> None:
    assert extract_identifiers(text) == expected


def test_identifiers_keep_extras_first_and_do_not_repeat() -> None:
    assert extract_identifiers("FIN-PAY-004 again FIN-PAY-004", extra=["FIN-PAY-004"]) == [
        "FIN-PAY-004"
    ]
    assert extract_identifiers("ERR-PORTAL-403", extra=["HR-GEN-000"]) == [
        "HR-GEN-000",
        "ERR-PORTAL-403",
    ]


def test_clean_text_normalises_whitespace_without_rewriting() -> None:
    assert clean_text("  a   b\t c ​\r\n\r\n d  ") == "a b c\n\nd"


def test_clean_removes_lines_repeated_on_many_pages() -> None:
    footer = "StarIT Education - internal"
    blocks = [Block("paragraph", footer, page=p) for p in (1, 2, 3)]
    blocks += [Block("paragraph", f"real text {p}", page=p) for p in (1, 2, 3)]
    cleaned = clean_document(ParsedDocument(title=" Title ", blocks=blocks))
    assert [b.text for b in cleaned.blocks] == ["real text 1", "real text 2", "real text 3"]
    assert cleaned.title == "Title"


def test_clean_keeps_a_repeated_line_when_there_are_few_pages() -> None:
    blocks = [Block("paragraph", "same", page=p) for p in (1, 2)]
    assert len(clean_document(ParsedDocument(title=None, blocks=blocks)).blocks) == 2


def test_embedding_input_adds_title_and_section_path() -> None:
    chunk = Chunk(0, "Body text.", ("3. Rules", "3.1 Late work"), None, 3)
    assert (
        embedding_input("Assignment Rules", chunk)
        == "Assignment Rules\n3. Rules > 3.1 Late work\n\nBody text."
    )
    bare = Chunk(0, "Body text.", (), None, 3)
    assert embedding_input("", bare) == "Body text."


def test_vector_literal_format() -> None:
    assert vector_literal([0.5, -1, 2.25]) == "[0.5,-1.0,2.25]"


async def test_fake_embeddings_are_deterministic_unit_vectors() -> None:
    client = FakeEmbeddingClient(dimensions=1536)
    first, again, other = await client.embed(["a", "a", "b"])
    assert first == again != other
    assert len(first) == 1536
    assert abs(sum(x * x for x in first) - 1.0) < 1e-9


class _Response:
    def __init__(self, vectors: list[list[float]]) -> None:
        self.data = [{"embedding": v} for v in vectors]


async def test_litellm_client_checks_the_dimensions(monkeypatch: pytest.MonkeyPatch) -> None:
    import litellm

    async def short(**_kwargs: object) -> _Response:
        return _Response([[0.1, 0.2]])

    monkeypatch.setattr(litellm, "aembedding", short)
    client = LiteLLMEmbeddingClient("openai", "text-embedding-3-small", 1536)
    with pytest.raises(IngestError) as caught:
        await client.embed(["x"])
    assert caught.value.code == "dimension_mismatch"
    assert caught.value.retryable is False


async def test_litellm_client_checks_the_count_and_wraps_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import litellm

    async def one_vector(**_kwargs: object) -> _Response:
        return _Response([[0.0] * 4])

    async def boom(**_kwargs: object) -> _Response:
        raise RuntimeError("rate limited")

    client = LiteLLMEmbeddingClient("openai", "m", 4)
    monkeypatch.setattr(litellm, "aembedding", one_vector)
    with pytest.raises(IngestError, match="asked for 2"):
        await client.embed(["a", "b"])
    monkeypatch.setattr(litellm, "aembedding", boom)
    with pytest.raises(IngestError) as caught:
        await client.embed(["a"])
    assert caught.value.code == "embedding_failed"
    assert "rate limited" in caught.value.message
    assert caught.value.retryable is True


async def test_litellm_client_passes_model_and_dimensions(monkeypatch: pytest.MonkeyPatch) -> None:
    import litellm

    seen: dict[str, object] = {}

    async def capture(**kwargs: object) -> _Response:
        seen.update(kwargs)
        return _Response([[0.0] * 8])

    monkeypatch.setattr(litellm, "aembedding", capture)
    await LiteLLMEmbeddingClient("openai", "text-embedding-3-small", 8).embed(["x"])
    assert seen["model"] == "openai/text-embedding-3-small"
    assert seen["dimensions"] == 8
