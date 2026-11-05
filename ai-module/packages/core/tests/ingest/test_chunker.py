"""文件：测试——切块算法
测什么：空文档无块；每章一块并带标题与路径；开头无标题的文字路径为空；短章节合并到目标大小；
块不超上限且标题不落在块尾；长章节分块时有重叠、跨章节无重叠；长段落按句子拆，超长句按词拆；
小表格保持完整，大表格按行拆并重复表头；代码块围栏成对；编号包含文档编号；
  页码取第一个有页码的块；
示例文档切出来的块都是健全的。
"""

import csv
from pathlib import Path

import pytest
from starit_core.ingest.chunker import chunk_document
from starit_core.ingest.clean import clean_document
from starit_core.ingest.models import Block, ParsedDocument
from starit_core.ingest.parsers import parser_for
from starit_core.ingest.tokens import count_tokens

SAMPLE_DATA = Path(__file__).resolve().parents[4] / "sample-data"


def words(text: str) -> int:
    return len(text.split())


def doc(*blocks: Block) -> ParsedDocument:
    return ParsedDocument(title="T", blocks=list(blocks))


def heading(text: str, level: int = 1) -> Block:
    return Block("heading", text, level=level)


def para(text: str) -> Block:
    return Block("paragraph", text)


def chunks(d: ParsedDocument, **kw: int) -> list:  # type: ignore[type-arg]
    params = {"target_tokens": 0, "max_tokens": 100, "overlap_tokens": 0, **kw}
    return chunk_document(d, doc_code="DOC-1", count=words, **params)


def test_empty_document_has_no_chunks() -> None:
    assert chunks(doc()) == []
    assert chunks(doc(heading("1. Empty"))) == []


def test_each_section_is_a_chunk_with_its_heading_and_path() -> None:
    result = chunks(doc(heading("1. A"), para("alpha beta"), heading("1.1 B", 2), para("gamma")))
    assert [c.heading_path for c in result] == [("1. A",), ("1. A", "1.1 B")]
    assert result[0].text == "1. A\n\nalpha beta"
    assert result[1].text == "1.1 B\n\ngamma"
    assert [c.index for c in result] == [0, 1]


def test_text_before_the_first_heading_has_an_empty_path() -> None:
    result = chunks(doc(para("intro text"), heading("1. A"), para("alpha")))
    assert result[0].heading_path == ()
    assert result[0].text == "intro text"


def test_short_sections_are_combined_until_the_target_size() -> None:
    sections = [x for n in range(6) for x in (heading(f"{n}. S"), para("w " * 19))]
    result = chunks(doc(*sections), target_tokens=40, max_tokens=100)
    assert 1 < len(result) < 6
    assert all(c.token_count <= 100 for c in result)
    assert result[0].text.count("S") >= 2  # more than one section in the first chunk
    one_per_section = chunks(doc(*sections), target_tokens=0, max_tokens=100)
    assert len(one_per_section) == 6


def test_a_chunk_never_exceeds_the_maximum_and_a_heading_never_ends_a_chunk() -> None:
    body = [heading("1. First")] + [para(f"p{n} " + "x " * 28) for n in range(7)]
    body += [heading("2. Second"), para("tail " * 5)]
    result = chunks(doc(*body), target_tokens=60, max_tokens=100)
    assert all(c.token_count <= 100 for c in result)
    for c in result:
        last_block = c.text.split("\n\n")[-1]
        assert last_block not in ("1. First", "2. Second")


def test_a_long_section_overlaps_between_chunks() -> None:
    paragraphs = [para(f"p{n} " + "x " * 29) for n in range(6)]  # 30 words each
    result = chunks(doc(heading("1. Long"), *paragraphs), max_tokens=100, overlap_tokens=40)
    assert len(result) >= 3
    for earlier, later in zip(result, result[1:], strict=False):
        last_paragraph = earlier.text.split("\n\n")[-1]
        assert later.text.startswith(last_paragraph), (earlier.index, later.index)


def test_no_overlap_across_a_section_boundary() -> None:
    result = chunks(
        doc(heading("1. A"), para("a " * 30), heading("2. B"), para("b " * 30)), overlap_tokens=40
    )
    assert "a a" not in result[1].text


def test_a_long_paragraph_is_split_at_sentences() -> None:
    sentences = " ".join(f"Sentence number {n} ends here." for n in range(40))
    result = chunks(doc(para(sentences)), max_tokens=60)
    assert len(result) > 1
    assert all(c.token_count <= 60 for c in result)
    assert all(c.text.rstrip().endswith(".") for c in result)
    assert " ".join(c.text for c in result) == sentences


def test_one_endless_sentence_is_split_at_words() -> None:
    result = chunks(doc(para("word " * 250)), max_tokens=100)
    assert len(result) == 3
    assert all(c.token_count <= 100 for c in result)


def test_a_small_table_stays_whole() -> None:
    table = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |"
    result = chunks(doc(heading("1. T"), Block("table", table)))
    assert table in result[0].text


def test_a_large_table_is_split_between_rows_and_repeats_its_header() -> None:
    rows = [f"| row{n} | " + "v " * 8 + "|" for n in range(30)]
    table = "\n".join(["| name | value |", "|---|---|", *rows])
    result = chunks(doc(Block("table", table)), max_tokens=60)
    assert len(result) > 1
    for c in result:
        lines = c.text.split("\n")
        assert lines[:2] == ["| name | value |", "|---|---|"]
        assert all(line.startswith("|") and line.endswith("|") for line in lines)  # no row cut
    assert sum(len(c.text.split("\n")) - 2 for c in result) == 30


def test_large_code_keeps_balanced_fences() -> None:
    code = (
        "```bash\n"
        + "\n".join(f"echo line {n} and some more words here" for n in range(40))
        + "\n```"
    )
    result = chunks(doc(Block("code", code)), max_tokens=50)
    assert len(result) > 1
    for c in result:
        assert c.text.startswith("```bash\n") and c.text.endswith("\n```")
        assert c.text.count("```") == 2


def test_identifiers_include_the_document_code() -> None:
    result = chunks(doc(heading("1. Errors"), para("ERR-PORTAL-403 means the device limit.")))
    assert result[0].identifiers == ("DOC-1", "ERR-PORTAL-403")


def test_page_comes_from_the_first_block_with_one() -> None:
    result = chunks(
        doc(Block("paragraph", "on page two", page=2), Block("paragraph", "later", page=3))
    )
    assert result[0].page == 2


# --- the real sample documents ------------------------------------------------------------


def sample_rows() -> list[dict[str, str]]:
    with open(SAMPLE_DATA / "documents" / "manifest.csv", newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


@pytest.mark.parametrize("row", sample_rows(), ids=lambda r: r["file"])
def test_sample_document_chunks_are_sound(row: dict[str, str]) -> None:
    parsed = clean_document(
        parser_for(row["format"]).parse(SAMPLE_DATA / "documents" / row["file"])
    )
    result = chunk_document(
        parsed, doc_code=row["doc_id"], target_tokens=400, max_tokens=500, overlap_tokens=50
    )
    assert result, row["file"]
    joined = "\n\n".join(c.text for c in result)
    for c in result:
        assert 0 < c.token_count <= 500
        assert c.token_count == count_tokens(c.text)
        assert row["doc_id"] in c.identifiers
    # Nothing is lost: every block appears whole in some chunk (these documents are short).
    for block in parsed.blocks:
        assert block.text in joined, (row["file"], block.type, block.text[:60])
    # Tables are never cut: each table block sits whole inside one chunk.
    for block in parsed.blocks:
        if block.type == "table":
            assert any(block.text in c.text for c in result), (row["file"], block.text[:60])
