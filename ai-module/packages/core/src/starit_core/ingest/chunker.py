"""文件：ingest/chunker.py
作用：结构感知切块——把解析后的文档切成适合检索的文本块。
为什么要切：整篇文档太长，不能整篇向量化或放进提示词；切得太碎又会丢上下文。
算法思想（这是本项目最需要读懂的算法之一）：
  1. 先按标题把文档分成“章节”，每个章节以它的标题行开头；
  2. 把章节展开成“单元”（标题行、段落、列表项、表格、代码）按阅读顺序排好；
  3. 依次把单元装进当前块，规则是：
     - 单个块最多 max_tokens；装不下就结束当前块，开新块（size_break）；
     - 遇到新标题时，只有当前块已达到 target_tokens 才在章节边界结束（boundary_break），
       所以短章节会被合并成大小合适的块；target 设 0 则“一章一块”；
     - 标题永远不会落在块尾：如果块尾是标题，把它挪到下一块，让标题总和它下面的正文在一起；
  4. 表格和代码块尽量整块保留；放不下的表格按行拆，代码按行拆，每一块重复表头/代码围栏；
  5. 同一章节被迫分成多块时，下一块以上一块末尾的段落/列表项开头（不超过 overlap_tokens），
     让边界处的句子在两块里都能被看到（重叠）；
  6. 块的标题路径取它第一个单元的路径，块的文字包含它覆盖的所有标题。
每个块还会记录文中出现的精确编号(identifiers)，供关键词检索加分。
"""

import re
from collections.abc import Callable
from dataclasses import dataclass

from starit_core.ingest.identifiers import extract_identifiers
from starit_core.ingest.models import Block, Chunk, ParsedDocument
from starit_core.ingest.tokens import count_tokens

# 块与块（单元之间）用空行分隔，算作 2 个 token
_SEPARATOR_TOKENS = 2  # the blank line between blocks
# 按句末标点切句，用来拆分过长的段落
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")


@dataclass
class _Section:
    """一个章节：标题路径、标题行、章节下的块。"""

    path: tuple[str, ...]
    heading: str | None
    blocks: list[Block]


@dataclass
class _Unit:
    """切块时的最小单位：类型(heading 或块类型)、文字、token 数、页码、所属标题路径。"""

    kind: str  # "heading" or a block type
    text: str
    tokens: int
    page: int | None
    path: tuple[str, ...]


def chunk_document(
    doc: ParsedDocument,
    *,
    doc_code: str,
    target_tokens: int = 400,
    max_tokens: int = 500,
    overlap_tokens: int = 50,
    count: Callable[[str], int] = count_tokens,
) -> list[Chunk]:
    """把解析后的文档切成文本块。

    参数：
      doc：解析结果；doc_code：文档编号（会作为编号记入每个块）；
      target_tokens：块的目标大小，达到后遇到新标题才结束；max_tokens：块的硬上限；
      overlap_tokens：同一章节分块时，下一块带上上一块末尾的多少 token；
      count：计 token 的函数（测试里可替换）。
    返回：按顺序排好的 Chunk 列表。
    """
    units = _units(doc, max_tokens, count)
    chunks: list[Chunk] = []

    # emit：把一组单元合成一个块并记下（文字、标题路径、页码、token 数、编号）
    def emit(parts: list[_Unit]) -> None:
        text = "\n\n".join(u.text for u in parts)
        chunks.append(
            Chunk(
                index=len(chunks),
                text=text,
                heading_path=parts[0].path,
                page=next((u.page for u in parts if u.page is not None), None),
                token_count=count(text),
                identifiers=tuple(extract_identifiers(text, extra=[doc_code])),
            )
        )

    current: list[_Unit] = []
    used = 0
    new_units = 0  # units added since the last chunk was emitted (not carried over)
    for unit in units:
        need = unit.tokens + _SEPARATOR_TOKENS
        # 两种结束当前块的条件：装不下 / 到了章节边界且块已够大
        size_break = new_units > 0 and used + need > max_tokens
        boundary_break = new_units > 0 and unit.kind == "heading" and used >= target_tokens
        if size_break or boundary_break:
            # 块尾的标题不能留在这一块：先摘出来，带到下一块
            trailing = current.pop() if current and current[-1].kind == "heading" else None
            emitted = current
            if emitted:
                emit(emitted)
            # 同一章节内被迫分块时才带重叠；跨章节或有标题要带时不重叠
            carry = (
                _overlap(emitted, overlap_tokens)
                if trailing is None and not boundary_break and unit.path == emitted[-1].path
                else []
            )
            current = carry + ([trailing] if trailing else [])
            used = sum(u.tokens + _SEPARATOR_TOKENS for u in current)
            new_units = 1 if trailing else 0
            # 重叠加新单元仍超上限：放弃重叠
            if used + need > max_tokens:  # no room for the carried text and this unit
                current = [trailing] if trailing else []
                used = sum(u.tokens + _SEPARATOR_TOKENS for u in current)
        current.append(unit)
        used += need
        new_units += 1
    if new_units:
        emit(current)
    return chunks


def _units(doc: ParsedDocument, max_tokens: int, count: Callable[[str], int]) -> list[_Unit]:
    """把文档展开成单元序列：每个章节先放标题行，再放它的块（过大的块先拆小）。"""
    units: list[_Unit] = []
    for section in _sections(doc):
        heading_cost = 0
        if section.heading:
            heading_cost = count(section.heading) + _SEPARATOR_TOKENS
            units.append(
                _Unit("heading", section.heading, count(section.heading), None, section.path)
            )
        for block in section.blocks:
            # Leave room for the heading so heading plus first piece always fits in one chunk.
            # 给标题留出空间，保证“标题 + 第一段”总能放进同一个块
            for text in _split_block(block, max_tokens - heading_cost, count):
                units.append(_Unit(block.type, text, count(text), block.page, section.path))
    return units


def _sections(doc: ParsedDocument) -> list[_Section]:
    """按标题把块分组成章节。二级标题的路径是（一级标题, 本标题）；开头没有标题的内容也成一节。"""
    sections = [_Section((), None, [])]
    path: list[str] = []
    for block in doc.blocks:
        if block.type == "heading":
            path = [block.text] if block.level <= 1 or not path else [path[0], block.text]
            sections.append(_Section(tuple(path), block.text, []))
        else:
            sections[-1].blocks.append(block)
    return [s for s in sections if s.blocks]


def _overlap(units: list[_Unit], overlap_tokens: int) -> list[_Unit]:
    """取块末尾连续的段落/列表项作为重叠，不超过预算；遇到表格或代码就停（它们不做重叠）。"""
    carry: list[_Unit] = []
    total = 0
    for unit in reversed(units):
        if unit.kind not in ("paragraph", "list_item"):
            break
        total += unit.tokens + _SEPARATOR_TOKENS
        if total > overlap_tokens:
            break
        carry.insert(0, unit)
    return carry


def _split_block(block: Block, budget: int, count: Callable[[str], int]) -> list[str]:
    """一个块放得下就原样返回，放不下按类型拆：表格按行、代码按行、其余按句子。"""
    if count(block.text) <= budget:
        return [block.text]
    if block.type == "table":
        return _split_table(block.text, budget, count)
    if block.type == "code":
        return _split_code(block.text, budget, count)
    return _split_prose(block.text, budget, count)


def _split_table(text: str, budget: int, count: Callable[[str], int]) -> list[str]:
    """按行拆表格，每个分块都重复前两行（表头和分隔行），让每块自己都读得懂。"""
    lines = text.split("\n")
    header, rows = lines[:2], lines[2:]
    pieces: list[str] = []
    current: list[str] = []
    for row in rows:
        candidate = "\n".join(header + current + [row])
        if current and count(candidate) > budget:
            pieces.append("\n".join(header + current))
            current = []
        current.append(row)
    if current:
        pieces.append("\n".join(header + current))
    return pieces


def _split_code(text: str, budget: int, count: Callable[[str], int]) -> list[str]:
    """按行拆代码，每个分块都补上代码围栏(```)，保持是合法的代码块。"""
    lines = text.split("\n")
    fence = lines[0] if lines[0].startswith("```") else "```"
    body = (
        [ln for ln in lines[1:] if not ln.startswith("```")]
        if lines[0].startswith("```")
        else lines
    )
    pieces: list[str] = []
    current: list[str] = []
    for line in body:
        candidate = "\n".join([fence, *current, line, "```"])
        if current and count(candidate) > budget:
            pieces.append("\n".join([fence, *current, "```"]))
            current = []
        current.append(line)
    if current:
        pieces.append("\n".join([fence, *current, "```"]))
    return pieces


def _split_prose(text: str, budget: int, count: Callable[[str], int]) -> list[str]:
    """在句末处拆长段落；单个句子本身超长时再按词拆。"""
    pieces: list[str] = []
    current = ""
    for sentence in _SENTENCE_SPLIT.split(text):
        for part in _split_words(sentence, budget, count):
            candidate = f"{current} {part}".strip()
            if current and count(candidate) > budget:
                pieces.append(current)
                current = part
            else:
                current = candidate
    if current:
        pieces.append(current)
    return pieces


def _split_words(text: str, budget: int, count: Callable[[str], int]) -> list[str]:
    """按词拆一段超长文字，尽量填满预算。"""
    if count(text) <= budget:
        return [text]
    pieces: list[str] = []
    current = ""
    for word in text.split():
        candidate = f"{current} {word}".strip()
        if current and count(candidate) > budget:
            pieces.append(current)
            current = word
        else:
            current = candidate
    if current:
        pieces.append(current)
    return pieces
