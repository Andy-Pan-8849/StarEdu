"""Prompt files and their versions. The version is written to the audit record of each run.

Change a prompt file and raise its version here, so a run can be matched to the text it used.
"""

from pathlib import Path

_DIRECTORY = Path(__file__).parent / "prompts"

PROMPT_VERSIONS = {"understand": "1", "generate": "1", "rewrite": "1"}


def prompt_text(name: str) -> str:
    return (_DIRECTORY / f"{name}.md").read_text(encoding="utf-8").strip()
