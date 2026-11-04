"""Derived content: a short summary and a few questions each chunk can answer, per chunk.

They are extra fields next to the chunk (`ai.chunk_derived`), never a replacement for its text, and
they enrich what is embedded, so a question worded unlike the document can still land near it.
Whether that helps is an experiment (docs/design/05, section 1.5), so it is off by default.
A model failure only means a chunk has no derived content; the document is still ingested.
"""

import json
import logging
from collections.abc import Sequence
from dataclasses import dataclass

from starit_core.ingest.models import Chunk
from starit_core.llm import ChatClient, ChatError, parse_json_object

logger = logging.getLogger("starit.ingest")

DERIVE_MODES = ("none", "summary", "questions", "all")
DERIVE_PROMPT_VERSION = "1"
QUESTIONS_PER_CHUNK = 3

_SYSTEM = (
    "Write retrieval aids for one passage of a company policy document. Use only what the "
    "passage says; never add facts. Reply with one JSON object and nothing else: "
    '{"summary": "...", "questions": ["...", "..."]}. '
    "summary: one or two sentences. questions: three short questions a employee or student "
    "might type that this passage answers, worded the way people ask, not copied from the text."
)


@dataclass(frozen=True)
class Derived:
    kind: str  # "summary" or "question"
    text: str


async def derive_chunks(
    chat: ChatClient, model: str, title: str, chunks: Sequence[Chunk], mode: str
) -> list[list[Derived]]:
    """One list of derived items per chunk, in order. `mode` is one of DERIVE_MODES."""
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
    return json.dumps([{"kind": d.kind, "text": d.text} for d in items])
