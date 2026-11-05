"""文件：report.py
作用：把一次检索评测的结果整理成 JSON、Markdown 报告，以及数据库里的评测记录
（表 ai.eval_runs 与 ai.eval_results）。
流程：build_report 把各模式的运行汇总成字典 -> render_markdown 转成中文 Markdown ->
write_reports 写文件 -> store_run 写数据库，方便以后对比不同时间的结果。
"""

import json
import subprocess
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine
from starit_core.config import Settings

from starit_eval import metrics
from starit_eval.metrics import Scored, Summary
from starit_eval.pricing import cost_usd
from starit_eval.runner import ModeRun, QuestionRun, SweepResult


def git_sha() -> str | None:
    """当前提交的短哈希，取不到（没装 git 等）返回 None；写进报告以便追溯。"""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, check=True
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    return out.stdout.strip() or None


def answerable(run: QuestionRun) -> bool:
    """这道题的检索是否属于“可回答”：应回答并且有来源文档。"""
    return run.question.should_answer and bool(run.question.source_docs)


def scored(runs: Sequence[QuestionRun]) -> list[Scored]:
    """挑出可回答的题，转成指标计算需要的 Scored 列表。"""
    return [
        Scored(r.question.type, tuple(r.doc_codes), r.question.source_docs)
        for r in runs
        if answerable(r)
    ]


def passed(run: QuestionRun) -> bool | None:
    """检索这一步算不算通过。
    - 有越权返回 -> 不通过；
    - 可回答题：前 6 个文档里有来源文档才通过；
    - 有来源但不该回答/无权读：来源文档不能出现在结果里；
    - 没有来源文档可参照（无答案的题）：返回 None，不判。
    """
    if run.violations:
        return False
    if answerable(run):
        return metrics.hit_at_k(run.doc_codes, run.question.source_docs, 6)
    if run.question.source_docs:
        return not set(run.question.source_docs) & set(run.doc_codes)
    return None  # no source document to judge by (unanswerable question)


def _summary_dict(summary: Summary) -> dict[str, float]:
    """把 Summary 转成保留 4 位小数的字典。"""
    return {
        "n": summary.n,
        "hit@1": round(summary.hit1, 4),
        "hit@3": round(summary.hit3, 4),
        "hit@6": round(summary.hit6, 4),
        "recall@6": round(summary.recall6, 4),
        "mrr": round(summary.mrr, 4),
    }


def build_report(
    *,
    label: str,
    settings: Settings,
    corpus: dict[str, Any],
    mode_runs: Sequence[ModeRun],
    sweep: SweepResult | None,
    embedding_tokens: int,
    rerank_model: str,
    embedding_model: str,
) -> dict[str, Any]:
    """把各检索模式的运行结果汇总成报告字典。

    内容：每种模式的总体指标、按题型指标、没命中的题、延迟 p50/p95、
    “可回答 vs 无答案”的最高分中位数（这是 grade_retrieval 阈值的依据）、越权块数、重排 token；
    再加权限扫描结果和估算费用。
    """
    modes: dict[str, Any] = {}
    for mode_run in mode_runs:
        runs = mode_run.runs
        latencies = [r.latency_ms for r in runs]
        top_answerable = [r.top_score for r in runs if answerable(r) and r.top_score is not None]
        top_unanswerable = [
            r.top_score for r in runs if not r.question.should_answer and r.top_score is not None
        ]
        modes[mode_run.mode] = {
            "overall": _summary_dict(metrics.summarize(scored(runs))),
            "by_type": {
                k: _summary_dict(v) for k, v in metrics.summarize_by_type(scored(runs)).items()
            },
            "missed": [r.question.id for r in runs if answerable(r) and not passed(r)],
            "latency_ms": {
                "p50": round(metrics.percentile(latencies, 50), 1),
                "p95": round(metrics.percentile(latencies, 95), 1),
            },
            "top_score": {
                "answerable_median": _median(top_answerable),
                "unanswerable_median": _median(top_unanswerable),
            },
            "violations": sum(len(r.violations) for r in runs),
            "rerank": {
                "input_tokens": mode_run.rerank_input_tokens,
                "output_tokens": mode_run.rerank_output_tokens,
                "failures": mode_run.rerank_failures,
            },
        }
    rerank_in = sum(m.rerank_input_tokens for m in mode_runs)
    rerank_out = sum(m.rerank_output_tokens for m in mode_runs)
    embed_cost = cost_usd(embedding_model, embedding_tokens)
    rerank_cost = cost_usd(rerank_model, rerank_in, rerank_out)
    return {
        "label": label,
        "date": datetime.now(UTC).isoformat(timespec="seconds"),
        "git_sha": git_sha(),
        "corpus": corpus,
        "config": {
            "embedding_model": embedding_model,
            "rerank_model": rerank_model,
            "keyword_k": settings.retrieval_keyword_k,
            "vector_k": settings.retrieval_vector_k,
            "rrf_k": settings.retrieval_rrf_k,
            "rerank_in": settings.retrieval_rerank_in,
            "final_k": settings.retrieval_final_k,
            "context_tokens": settings.retrieval_context_tokens,
            "chunk_target_tokens": settings.chunk_target_tokens,
        },
        "modes": modes,
        "leak_sweep": None
        if sweep is None
        else {"checked": sweep.checked, "violations": [list(v) for v in sweep.violations]},
        "cost": {
            "embedding_tokens": embedding_tokens,
            "rerank_input_tokens": rerank_in,
            "rerank_output_tokens": rerank_out,
            "estimated_usd": None
            if embed_cost is None and rerank_cost is None
            else round((embed_cost or 0) + (rerank_cost or 0), 5),
        },
    }


def _median(values: Sequence[float | None]) -> float | None:
    """中位数（忽略 None），没有数据返回 None。"""
    clean = sorted(v for v in values if v is not None)
    return None if not clean else round(clean[len(clean) // 2], 4)


def render_markdown(report: dict[str, Any]) -> str:
    """把报告字典渲染成中文 Markdown：总体结果表、按题型表、未命中的题、分数分布、权限回归、
    费用和局限。
    """
    c, cfg = report["corpus"], report["config"]
    lines = [
        f"# 检索评测报告：{report['label']}",
        "",
        f"- 日期：{report['date']}　提交：`{report['git_sha']}`",
        f"- 知识库：{c['documents']} 份文档、{c['chunks']} 个块（平均 {c['avg_tokens']} token），"
        f"分块目标 {cfg['chunk_target_tokens']} token",
        f"- 向量模型：`{cfg['embedding_model']}`；重排模型：`{cfg['rerank_model']}`",
        f"- 参数：关键词 top {cfg['keyword_k']}、向量 top {cfg['vector_k']}、RRF k={cfg['rrf_k']}、"
        f"重排输入 {cfg['rerank_in']}、最终 {cfg['final_k']} 个、上下文预算 {cfg['context_tokens']} token",
        "",
        "## 总体结果（只统计有来源文档的可回答问题）",
        "",
        "| mode | n | hit@1 | hit@3 | hit@6 | recall@6 | MRR | 检索 p50 ms | p95 ms | 越权块 |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for mode, data in report["modes"].items():
        o = data["overall"]
        lines.append(
            f"| {mode} | {o['n']} | {o['hit@1']} | {o['hit@3']} | {o['hit@6']} | {o['recall@6']} | "
            f"{o['mrr']} | {data['latency_ms']['p50']} | {data['latency_ms']['p95']} | {data['violations']} |"
        )
    types = sorted({t for d in report["modes"].values() for t in d["by_type"]})
    if types:
        lines += ["", "## 按题型（hit@6 / MRR，括号内为题数）", ""]
        lines += [
            "| 题型 | " + " | ".join(report["modes"]) + " |",
            "|---|" + "---|" * len(report["modes"]),
        ]
        for kind in types:
            cells = []
            for data in report["modes"].values():
                s = data["by_type"].get(kind)
                cells.append("–" if s is None else f"{s['hit@6']} / {s['mrr']} ({s['n']})")
            lines.append(f"| {kind} | " + " | ".join(cells) + " |")
    lines += ["", "## 前 6 个文档里没有来源的题", ""]
    for mode, data in report["modes"].items():
        missed = ", ".join(data["missed"]) or "无"
        lines.append(f"- **{mode}**：{missed}")
    lines += ["", "## 最高分：可回答 vs 无答案（中位数）", ""]
    lines += ["| mode | 可回答 | 无答案 / 应拒绝 |", "|---|---|---|"]
    for mode, data in report["modes"].items():
        t = data["top_score"]
        lines.append(f"| {mode} | {t['answerable_median']} | {t['unanswerable_median']} |")
    lines.append("")
    lines.append("（这些分数的分布是 M5 里 `grade_retrieval` 阈值的依据。）")
    sweep = report["leak_sweep"]
    lines += ["", "## 权限回归", ""]
    if sweep is None:
        lines.append(
            "本次没有运行全角色扫描。各模式运行里返回的块都经过独立规则检查，越权块数见上表。"
        )
    else:
        lines.append(
            f"{sweep['checked'] // 21} 个问题 × 7 个角色 × 3 种模式，共 {sweep['checked']} 次检索；"
            f"**越权的块：{len(sweep['violations'])}**。"
        )
        for violation in sweep["violations"][:20]:
            lines.append(f"- {violation}")
    cost = report["cost"]
    usd = "未知" if cost["estimated_usd"] is None else f"约 {cost['estimated_usd']} 美元"
    lines += [
        "",
        "## 费用",
        "",
        f"向量化问题 {cost['embedding_tokens']} token；重排输入 {cost['rerank_input_tokens']} token、"
        f"输出 {cost['rerank_output_tokens']} token；按公开标价估算{usd}（价格来自第三方价格表，仅供参考）。",
        "",
        "## 局限",
        "",
        "- 知识库只有几十个块，候选列表几乎覆盖全部内容，各模式的差距会被压缩，**不能据此判断它们在真实规模上的优劣**。",
        "- 评测集每种题型只有几道题（关键词 3、版本 2、改写 1），任何一道题都会明显拉动比例。",
        "- 重排的结果取决于所用模型和提示词；失败时退回融合顺序，失败次数见各模式运行记录。",
        "",
    ]
    return "\n".join(lines)


def write_reports(out_dir: Path, report: dict[str, Any], name: str) -> tuple[Path, Path]:
    """把报告写成同名的 .md 和 .json 两个文件，返回它们的路径。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    markdown, data = out_dir / f"{name}.md", out_dir / f"{name}.json"
    markdown.write_text(render_markdown(report), encoding="utf-8")
    data.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return markdown, data


async def store_run(engine: AsyncEngine, mode_run: ModeRun, report: dict[str, Any]) -> str:
    """把一种模式的运行写入 ai.eval_runs（汇总）和 ai.eval_results（每题一行），返回运行 ID。"""
    summary = report["modes"][mode_run.mode]
    config = {**report["config"], "mode": mode_run.mode, "label": report["label"]}
    async with engine.begin() as conn:
        run_id = (
            await conn.execute(
                text(
                    "INSERT INTO ai.eval_runs (git_sha, config, summary) "
                    "VALUES (:sha, CAST(:config AS jsonb), CAST(:summary AS jsonb)) RETURNING id"
                ),
                {
                    "sha": report["git_sha"],
                    "config": json.dumps(config),
                    "summary": json.dumps(summary),
                },
            )
        ).scalar_one()
        for run in mode_run.runs:
            await conn.execute(
                text(
                    "INSERT INTO ai.eval_results "
                    "(run_id, question_id, role, passed, retrieved_doc_ids, latency_ms, notes) "
                    "VALUES (:run, :q, :role, :passed, CAST(:docs AS text[]), :latency, :notes)"
                ),
                {
                    "run": run_id,
                    "q": run.question.id,
                    "role": run.question.role,
                    "passed": passed(run),
                    "docs": run.doc_codes,
                    "latency": int(run.latency_ms),
                    "notes": json.dumps(
                        {
                            "top_score": run.top_score,
                            "violations": run.violations,
                            "rerank_failed": run.rerank_failed,
                        }
                    ),
                },
            )
    return str(run_id)
