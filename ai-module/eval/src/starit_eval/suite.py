"""One report for everything the evaluation measures: retrieval, permissions, answers, data.

The permission result is the gate: any document leaked to a role that may not read it fails the
whole run, whatever the other numbers say. The other numbers are a baseline, not a target.
"""

from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def render_all(
    *,
    retrieval: dict[str, Any],
    permission_violations: int,
    sweep_checked: int | None,
    answers: dict[str, Any],
    data: dict[str, Any],
    files: dict[str, Path],
    corpus: dict[str, int],
    questions: int,
    models: dict[str, str],
    git_sha: str | None,
) -> str:
    date = datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
    gate = "通过" if permission_violations == 0 else f"**失败：{permission_violations} 次越权**"
    swept = "" if sweep_checked is None else f"，权限扫描检查了 {sweep_checked} 次检索"
    lines = [
        f"# 完整评测报告（{date}）",
        "",
        f"提交 `{git_sha}`；知识库 {corpus['documents']} 份文档、{corpus['chunks']} 个块；"
        f"文档题 {questions} 道。模型："
        + "，".join(f"{k} `{v}`" for k, v in models.items())
        + "。",
        "",
        f"**权限回归（零容忍）：{gate}**{swept}。",
        "",
        "## 检索（只统计有来源文档的可回答题；hit@k 表示来源文档在前 k 个结果里的比例）",
        "",
        "| 模式 | n | hit@1 | hit@3 | hit@6 | MRR | 检索 p50 ms | 越权块 |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for mode, m in retrieval["modes"].items():
        o = m["overall"]
        lines.append(
            f"| {mode} | {o['n']} | {o['hit@1']} | {o['hit@3']} | {o['hit@6']} | {o['mrr']} | "
            f"{m['latency_ms']['p50']} | {m['violations']} |"
        )
    a, r = answers["answerable"], answers["must_refuse"]
    lines += [
        "",
        "## 答案（真实调用助手）",
        "",
        f"通过 {answers['passed']}/{answers['questions']}：应回答 {a['passed']}/{a['n']}，"
        f"应拒绝 {r['passed']}/{r['n']}。判分：事实 {answers['graded_by']['facts']} 题、"
        f"判官 {answers['graded_by']['judge']} 题（**未经人工抽查前不当作事实**）、"
        f"拒绝 {answers['graded_by']['refusal']} 题。反问澄清而没有回答："
        f"{answers['clarified_instead_of_answering']} 题。结束状态合法 "
        f"{answers['legal_end_states']}/{answers['questions']}。延迟 p50 "
        f"{answers['latency_s']['p50']} 秒、p95 {answers['latency_s']['p95']} 秒。",
        "",
        "| 题型 | 通过 |",
        "|---|---|",
        *[f"| {t} | {p}/{n} |" for t, (p, n) in answers["by_type"].items()],
        "",
        "## 数据题（SQL 与工具）",
        "",
        f"通过 {data['passed']}/{data['questions']}：应回答 {data['answerable']['passed']}/"
        f"{data['answerable']['n']}，应拒绝 "
        f"{data['must_refuse']['passed']}/{data['must_refuse']['n']}"
        + ("；没通过：" + ", ".join(data["failed"]) + "。" if data["failed"] else "。"),
        "",
        "## 文件",
        "",
        *[f"- {name}：`{path}`" for name, path in files.items()],
        "",
        "## 怎么读这份报告",
        "",
        "样本量小（每种题型几道到十几道），数字用来确认流程正确、看出方向，不能说明各方法在真实"
        "规模上的差别。没通过的题的原文和助手的回答在各自的报告里，先读它们再下结论。",
        "",
    ]
    return "\n".join(lines) + "\n"
