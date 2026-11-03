import csv
import re
from pathlib import Path

import pytest
from docx import Document
from starit_core.ingest.parsers import ParseError, parser_for

SAMPLE_DATA = Path(__file__).resolve().parents[4] / "sample-data"
DOCUMENTS = SAMPLE_DATA / "documents"


def sample_rows() -> list[dict[str, str]]:
    with open(DOCUMENTS / "manifest.csv", newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def source_of(row: dict[str, str]) -> str:
    path = SAMPLE_DATA / "_markdown-source" / row["domain"] / (Path(row["file"]).stem + ".md")
    return path.read_text(encoding="utf-8")


def norm(text: str) -> str:
    """Compare text ignoring markup, table pipes and spacing."""
    return re.sub(r"\s+", " ", re.sub(r"[`*]", "", text).replace("|", " ")).strip()


def flat_text(parsed) -> str:  # type: ignore[no-untyped-def]
    return norm(" ".join([parsed.title or ""] + [b.text for b in parsed.blocks]))


@pytest.mark.parametrize("row", sample_rows(), ids=lambda r: r["file"])
def test_structure_matches_the_markdown_source(row: dict[str, str]) -> None:
    """Every format yields the same title, sections, sub-sections and tables as the source."""
    parsed = parser_for(row["format"]).parse(DOCUMENTS / row["file"])
    source = source_of(row)
    assert parsed.title == re.search(r"^# (.*)$", source, re.M).group(1).strip()  # type: ignore[union-attr]
    sections = [b.text for b in parsed.blocks if b.type == "heading" and b.level == 1]
    subsections = [b.text for b in parsed.blocks if b.type == "heading" and b.level == 2]
    assert sections == [m.group(1).strip() for m in re.finditer(r"^## (.*)$", source, re.M)]
    assert subsections == [m.group(1).strip() for m in re.finditer(r"^### (.*)$", source, re.M)]
    source_tables = len(re.findall(r"(?m)^\|.*\n\|[-| :]+\n", source))
    assert sum(b.type == "table" for b in parsed.blocks) == source_tables


@pytest.mark.parametrize("row", sample_rows(), ids=lambda r: r["file"])
def test_all_the_text_is_kept_and_the_metadata_block_is_not(row: dict[str, str]) -> None:
    parsed = parser_for(row["format"]).parse(DOCUMENTS / row["file"])
    text = flat_text(parsed)
    body = source_of(row).split("\n---\n", 1)[1]
    for line in body.splitlines():
        line = line.strip()
        if not line or line.startswith("|") and re.fullmatch(r"[|\-: ]+", line):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")] if line.startswith("|") else [line]
        for cell in cells:
            cell = (
                re.sub(r"^(#{1,3} |- |\d+\. (?=\S))", "", cell)
                if not line.startswith("|")
                else cell
            )
            if cell.startswith(("## ", "### ")):
                continue
            assert norm(cell) in text, (row["file"], cell[:70])
    for leaked in ("Document ID", "doc_id:", "Campus scope", "effective_date:"):
        assert leaked not in text, (row["file"], leaked)


@pytest.mark.parametrize("row", sample_rows(), ids=lambda r: r["file"])
def test_blocks_have_sensible_types(row: dict[str, str]) -> None:
    parsed = parser_for(row["format"]).parse(DOCUMENTS / row["file"])
    assert parsed.blocks
    assert all(b.text.strip() for b in parsed.blocks)
    for block in parsed.blocks:
        if block.type == "table":
            lines = block.text.split("\n")
            assert lines[0].startswith("| ") and lines[1].startswith("|---")
        if block.type == "heading":
            assert block.level in (1, 2)
    if row["format"] == "pdf":
        assert all(b.page is not None for b in parsed.blocks)


def test_pdf_tables_come_out_as_markdown_tables() -> None:
    parsed = parser_for("pdf").parse(
        DOCUMENTS / "finance/FIN-REIM-002_travel-and-accommodation.pdf"
    )
    tables = [b.text for b in parsed.blocks if b.type == "table"]
    assert any("City type" in t and "Limit per night" in t for t in tables)


def test_text_files_tell_list_items_from_section_headings() -> None:
    parsed = parser_for("txt").parse(DOCUMENTS / "finance/FIN-TAX-008_invoice-requirements.txt")
    headings = [b.text for b in parsed.blocks if b.type == "heading"]
    assert headings[:3] == [
        "1. Company invoice details",
        "2. Valid invoices",
        "3. Train tickets, flights and taxis",
    ]
    items = [b.text for b in parsed.blocks if b.type == "list_item"]
    assert any(
        i.startswith("Electronic VAT invoices") for i in items
    )  # numbered "1." under heading 2


def test_the_superseded_text_policy_keeps_its_own_title() -> None:
    parsed = parser_for("txt").parse(
        DOCUMENTS / "hr/HR-REC-001_recruitment-policy-v1.0-superseded.txt"
    )
    assert parsed.title == "Recruitment Policy (version 1.0, superseded)"


def test_markdown_keeps_code_fences(tmp_path: Path) -> None:
    path = tmp_path / "a.md"
    path.write_text(
        "---\ndoc_id: X\n---\n\n# Title\n\n## 1. Install\n\nRun:\n\n```bash\nuv sync\nuv run pytest\n```\n\nDone.\n"
    )
    parsed = parser_for("md").parse(path)
    code = [b for b in parsed.blocks if b.type == "code"]
    assert code[0].text == "```bash\nuv sync\nuv run pytest\n```"
    assert [b.type for b in parsed.blocks] == ["heading", "paragraph", "code", "paragraph"]


def test_docx_without_heading_styles_falls_back_to_bold_numbered_lines(tmp_path: Path) -> None:
    document = Document()
    document.add_paragraph().add_run("1. Scope").bold = True
    document.add_paragraph("This policy applies to everyone.")
    document.add_paragraph().add_run("A bold sentence that is not numbered").bold = True
    path = tmp_path / "plain.docx"
    document.save(str(path))
    parsed = parser_for("docx").parse(path)
    assert [(b.type, b.text) for b in parsed.blocks] == [
        ("heading", "1. Scope"),
        ("paragraph", "This policy applies to everyone."),
        ("paragraph", "A bold sentence that is not numbered"),
    ]


@pytest.mark.parametrize("fmt", ["docx", "pdf"])
def test_a_corrupt_binary_file_is_a_parse_error(tmp_path: Path, fmt: str) -> None:
    path = tmp_path / f"broken.{fmt}"
    path.write_bytes(b"this is not really a document" * 10)
    with pytest.raises(ParseError):
        parser_for(fmt).parse(path)


def test_an_empty_pdf_is_a_parse_error(tmp_path: Path) -> None:
    path = tmp_path / "empty.pdf"
    path.write_bytes(b"")
    with pytest.raises(ParseError):
        parser_for("pdf").parse(path)


def test_a_text_file_that_is_not_utf8_is_a_parse_error(tmp_path: Path) -> None:
    path = tmp_path / "latin.txt"
    path.write_bytes("caf\xe9".encode("latin-1"))
    with pytest.raises(ParseError):
        parser_for("txt").parse(path)


def test_unknown_format_is_rejected() -> None:
    with pytest.raises(ParseError):
        parser_for("xlsx")


@pytest.mark.parametrize("row", sample_rows(), ids=lambda r: r["file"])
def test_every_identifier_in_the_source_survives_parsing(row: dict[str, str]) -> None:
    """Exact-match search depends on identifiers (FIN-TAX-008, ERR-PORTAL-403...) staying whole."""
    from starit_core.ingest.identifiers import extract_identifiers

    parsed = parser_for(row["format"]).parse(DOCUMENTS / row["file"])
    body = source_of(row).split("\n---\n", 1)[1]
    wanted = set(extract_identifiers(body))
    got = set(extract_identifiers(" ".join([parsed.title or ""] + [b.text for b in parsed.blocks])))
    assert wanted <= got, (row["file"], wanted - got)


def test_a_hyphenated_identifier_wrapped_in_a_pdf_stays_whole() -> None:
    parsed = parser_for("pdf").parse(
        DOCUMENTS / "finance/FIN-REIM-001_expense-reimbursement-policy.pdf"
    )
    assert any("Invoice rules are in FIN-TAX-008." in b.text for b in parsed.blocks)
