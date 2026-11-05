"""文件：ingest/derive.py
作用：为每个文本块让模型生成“衍生内容”——一句摘要，和几个这段能回答的问题。
主要思想：它们是块旁边的附加字段(ai.chunk_derived)，不替换原文；用来丰富被嵌入的内容，
这样措辞和文档不一样的提问也能落到这段附近。
这有没有用是一个实验(docs/design/05 第 1.5 节)，所以默认关闭。
模型失败只意味着这个块没有衍生内容，文档照常入库。
"""

import json
import logging
from collections.abc import Sequence
from dataclasses import dataclass

from starit_core.ingest.models import Chunk
from starit_core.llm import ChatClient, ChatError, parse_json_object

logger = logging.getLogger("starit.ingest")

# 模式：不生成 / 只摘要 / 只问题 / 都生成
DERIVE_MODES = ("none", "summary", "questions", "all")
# 提示词版本；改了提示词要升版本
DERIVE_PROMPT_VERSION = "1"
QUESTIONS_PER_CHUNK = 3

# 给模型的指令：只能依据段落内容，返回 JSON {summary, questions}
_SYSTEM = (
    "Write retrieval aids for one passage of a company policy document. Use only what the "
    "passage says; never add facts. Reply with one JSON object and nothing else: "
    '{"summary": "...", "questions": ["...", "..."]}. '
    "summary: one or two sentences. questions: three short questions a employee or student "
    "might type that this passage answers, worded the way people ask, not copied from the text."
)


@dataclass(frozen=True)
class Derived:
    """一条衍生内容：kind 是 summary 或 question，text 是内容。"""

    kind: str  # "summary" or "question"
    text: str


async def derive_chunks(
    chat: ChatClient, model: str, title: str, chunks: Sequence[Chunk], mode: str
) -> list[list[Derived]]:
    """为一批块生成衍生内容。

    参数：chat 聊天客户端；model 模型；title 文档标题；chunks 块；mode 取值见 DERIVE_MODES。
    返回：与 chunks 等长的列表，每项是该块的 Derived 列表。mode 不合法抛 ValueError。
    """
    if mode not in DERIVE_MODES:
        raise ValueError(f"unknown derive mode {mode!r}; use one of {', '.join(DERIVE_MODES)}")
    if mode == "none":
        return [[] for _ in chunks]
    wanted_summary = mode in ("summary", "all")
    wanted_questions = mode in ("questions", "all")
    result: list[list[Derived]] = []
    for chunk in chunks:
        user = f"Document: {title}\nSection: {' > '.join(chunk.heading_path)}\n\n{chunk.text}"
        try:
            reply = await chat.complete(
                [{"role": "system", "content": _SYSTEM}, {"role": "user", "content": user}],
                model=model,
                json_mode=True,
                max_tokens=400,
            )
            data = parse_json_object(reply.text)
        except ChatError as exc:
            logger.warning("derived content for a chunk of %r failed: %s", title, exc)
            result.append([])
            continue
        items: list[Derived] = []
        summary = str(data.get("summary") or "").strip()
        if wanted_summary and summary:
            items.append(Derived("summary", summary))
        questions = data.get("questions")
        if wanted_questions and isinstance(questions, list):
            asked = [str(q).strip() for q in questions if str(q).strip()]
            items += [Derived("question", text) for text in asked[:QUESTIONS_PER_CHUNK]]
        result.append(items)
    return result


def derived_json(items: Sequence[Derived]) -> str:
    """把衍生内容列表转成 JSON 字符串，用于写库。"""
    return json.dumps([{"kind": d.kind, "text": d.text} for d in items])
