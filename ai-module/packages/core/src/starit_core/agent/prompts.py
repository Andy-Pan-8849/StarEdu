"""文件：agent/prompts.py
作用：读取提示词文件（prompts/*.md），并登记每个提示词的版本号。
主要思想：版本号随每次运行写进审计记录；改了提示词文件就要同步升版本，
这样能把任何一次回答对上当时用的提示词。
"""

from pathlib import Path

_DIRECTORY = Path(__file__).parent / "prompts"

# 提示词版本表：改提示词必须在这里升版本
PROMPT_VERSIONS = {
    "understand": "3",
    "generate": "2",
    "rewrite": "1",
    "plan_data": "1",
    "sql": "1",
    "answer_data": "1",
}


def prompt_text(name: str) -> str:
    """读取名为 name 的提示词（prompts/<name>.md）并去掉首尾空白。"""
    return (_DIRECTORY / f"{name}.md").read_text(encoding="utf-8").strip()
