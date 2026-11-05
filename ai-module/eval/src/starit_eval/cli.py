"""文件：cli.py
作用：评测的命令行入口 `starit-eval`（通过 `make eval ARGS="..."` 使用）。
子命令：retrieval（检索，可 --all-modes、--leak-sweep）/ answers（114 道文档题）/
agent（代表性问题抽查）/ data（数据题）/ all（全部合成一份报告）/ matrix（对比实验）。
重要原则：真实运行会调用付费模型，所以每个子命令先打印“会调用多少次、多少 token、
按标价约多少钱”，然后问是否继续（Proceed? [y/N]）；加 --yes 才跳过询问。
估算是上限（不含重试），实际费用通常更低。
"""

import argparse
import asyncio
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine
from starit_core.auth import Identity
from starit_core.config import Settings, get_settings
from starit_core.db import create_engine
from starit_core.embeddings import EmbeddingClient, embedding_client
from starit_core.ingest.tokens import count_tokens
from starit_core.llm import ChatClient, chat_client
from starit_core.retrieval import MODES
from starit_core.retrieval.rerank import LLMReranker

from starit_eval.dataset import AI_MODULE, Question, load_identities, load_manifest, load_questions
from starit_eval.pricing import cost_usd
from starit_eval.report import build_report, store_run, write_reports
from starit_eval.runner import embed_questions, evaluate_mode, leak_sweep

# 报告默认写到仓库的 docs/eval/
DEFAULT_OUT = AI_MODULE.parent / "docs" / "eval"
# 估算用的常数：重排提示里的指令和问题；每段落的编号头
RERANK_OVERHEAD_TOKENS = 160  # the instructions and the question
PASSAGE_HEADER_TOKENS = 40  # "[3] HR-REC-001 v2.1 (active) - title - section"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """定义并解析命令行参数（子命令和选项）。"""
    parser = argparse.ArgumentParser(prog="starit-eval", description="StarEdu AI module evaluation")
    sub = parser.add_subparsers(dest="command", required=True)
    retrieval = sub.add_parser("retrieval", help="measure retrieval quality and permissions")
    retrieval.add_argument(
        "--mode", action="append", choices=MODES, help="a mode to run; repeatable"
    )
    retrieval.add_argument("--all-modes", action="store_true", help="run all four modes")
    retrieval.add_argument("--leak-sweep", action="store_true", help="every question as every role")
    retrieval.add_argument("--yes", action="store_true", help="do not ask before spending")
    retrieval.add_argument("--label", default=None, help="name of the run, used in the report")
    retrieval.add_argument("--out", type=Path, default=DEFAULT_OUT, help="report directory")
    retrieval.add_argument("--no-db", action="store_true", help="do not write ai.eval_runs rows")
    retrieval.add_argument(
        "--dry-run", action="store_true", help="fake embeddings and reranker, no cost"
    )
    agent = sub.add_parser("agent", help="ask the assistant representative questions for real")
    agent.add_argument(
        "--compare-generate", default=None, help="a second model for the answer step"
    )
    agent.add_argument("--yes", action="store_true", help="do not ask before spending")
    agent.add_argument("--out", type=Path, default=DEFAULT_OUT, help="report directory")
    data = sub.add_parser("data", help="ask the assistant the structured-data questions for real")
    data.add_argument("--only", action="append", help="a question id (SQL-07); repeatable")
    data.add_argument("--yes", action="store_true", help="do not ask before spending")
    data.add_argument("--out", type=Path, default=DEFAULT_OUT, help="report directory")
    answers = sub.add_parser("answers", help="ask the document questions and grade the answers")
    answers.add_argument("--only", action="append", help="a question id (DOC-07); repeatable")
    answers.add_argument("--yes", action="store_true", help="do not ask before spending")
    answers.add_argument("--no-db", action="store_true", help="do not write ai.eval_runs rows")
    answers.add_argument("--out", type=Path, default=DEFAULT_OUT, help="report directory")
    everything = sub.add_parser(
        "all", help="retrieval, permissions, answers and data in one report"
    )
    everything.add_argument("--yes", action="store_true", help="do not ask before spending")
    everything.add_argument("--no-db", action="store_true", help="do not write ai.eval_runs rows")
    everything.add_argument("--out", type=Path, default=DEFAULT_OUT, help="report directory")
    matrix = sub.add_parser("matrix", help="the experiment matrix (chunk size, weighting, derived)")
    matrix.add_argument("--only", action="append", help="an experiment name; repeatable")
    matrix.add_argument("--yes", action="store_true", help="do not ask before spending")
    matrix.add_argument("--out", type=Path, default=DEFAULT_OUT, help="report directory")
    args = parser.parse_args(argv)
    if args.command == "retrieval" and not (args.mode or args.all_modes or args.leak_sweep):
        parser.error("choose --mode, --all-modes or --leak-sweep")
    return args


async def corpus_stats(engine: AsyncEngine) -> dict[str, int]:
    """知识库的规模：文档数、块数、平均块大小，写进报告。"""
    async with engine.connect() as conn:
        row = (
            await conn.execute(
                text(
                    "SELECT count(DISTINCT document_id), count(*), coalesce(round(avg(token_count)), 0) "
                    "FROM ai.document_chunks"
                )
            )
        ).one()
        capped = (
            await conn.execute(
                text("SELECT coalesce(avg(least(token_count, 350)), 0) FROM ai.document_chunks")
            )
        ).scalar_one()
    return {
        "documents": int(row[0]),
        "chunks": int(row[1]),
        "avg_tokens": int(row[2]),
        "avg_capped": int(capped),
    }


def estimate(
    settings: Settings,
    questions: Sequence[Question],
    modes: Sequence[str],
    sweep: bool,
    avg_capped: int,
) -> dict[str, float | int | None]:
    """估算一次检索评测会调用多少次嵌入和重排、多少 token（上限）。"""
    embedding_tokens = sum(count_tokens(q.question) for q in questions)
    rerank_calls = len(questions) if "hybrid_rerank" in modes else 0
    per_call = RERANK_OVERHEAD_TOKENS + settings.retrieval_rerank_in * (
        min(avg_capped, settings.rerank_passage_tokens) + PASSAGE_HEADER_TOKENS
    )
    rerank_in = rerank_calls * per_call
    rerank_out = rerank_calls * (
        settings.retrieval_rerank_in * 12
    )  # {"id": 3, "score": 9}, per passage
    embed_cost = cost_usd(settings.embedding_model, embedding_tokens)
    rerank_cost = cost_usd(settings.model_rerank, rerank_in, rerank_out) if rerank_calls else 0.0
    total = None if embed_cost is None or rerank_cost is None else embed_cost + rerank_cost
    return {
        "questions": len(questions),
        "embedding_calls": -(-len(questions) // 64),
        "embedding_tokens": embedding_tokens,
        "rerank_calls": rerank_calls,
        "rerank_input_tokens": rerank_in,
        "rerank_output_tokens": rerank_out,
        "usd": None if total is None else round(total, 5),
        "sweep_queries": 7 * len(questions) * 3 if sweep else 0,
    }


def _proceed() -> bool:
    """在终端问用户是否继续；非交互环境下读不到输入会报错，此时应加 --yes。"""
    return input("Proceed? [y/N] ").strip().lower() in ("y", "yes")


def _confirm(args: argparse.Namespace, figures: dict[str, float | int | None]) -> bool:
    """打印将要进行的调用与估算费用，再询问是否继续（--yes 则直接继续）。返回是否继续。"""
    usd = "unknown" if figures["usd"] is None else f"about ${figures['usd']}"
    print(
        f"\nThis run will call hosted models:\n"
        f"  question embeddings: {figures['embedding_calls']} call(s), {figures['embedding_tokens']} tokens\n"
        f"  reranking: {figures['rerank_calls']} call(s), up to {figures['rerank_input_tokens']} input and "
        f"{figures['rerank_output_tokens']} output tokens\n"
        f"  estimated cost at list price: {usd}\n"
        f"  (the {figures['sweep_queries']} permission-sweep queries only read the database)\n"
    )
    if args.yes:
        return True
    return _proceed()


async def run_retrieval(args: argparse.Namespace) -> int:
    """检索评测子命令：估算 -> 确认 -> 各模式运行 -> 可选越权扫描 -> 写报告和数据库记录。
    返回退出码（有越权则非 0）。
    """
    settings = get_settings()
    engine = create_engine(settings)
    questions, identities, manifest = load_questions(), load_identities(), load_manifest()
    modes = list(MODES) if args.all_modes else list(dict.fromkeys(args.mode or []))
    corpus = await corpus_stats(engine)

    embedder: EmbeddingClient
    chat: ChatClient
    if args.dry_run:
        from starit_core.embeddings import FakeEmbeddingClient
        from starit_core.llm import FakeChatClient

        embedder = FakeEmbeddingClient(model=settings.embedding_model)
        chat = FakeChatClient(lambda _m: '{"ranking": []}')
        print("Dry run: fake embeddings and a fake reranker. The numbers mean nothing.")
    else:
        figures = estimate(settings, questions, modes, args.leak_sweep, corpus["avg_capped"])
        if not _confirm(args, figures):
            print("Cancelled.")
            await engine.dispose()
            return 1
        embedder = embedding_client(settings)
        chat = chat_client(settings)
    outcome = await retrieval_phase(
        settings, engine, embedder, chat, questions, identities, manifest, corpus, modes,
        sweep=args.leak_sweep, label=args.label or ("dry-run" if args.dry_run else "+".join(modes) or "leak-sweep"),
        out=args.out, store_in_db=not args.no_db and not args.dry_run,
    )  # fmt: skip
    await engine.dispose()
    print(f"report: {outcome.markdown}\ndata:   {outcome.data}")
    if outcome.violations:
        print(f"PERMISSION VIOLATIONS: {outcome.violations}", file=sys.stderr)
        return 2
    return 0


@dataclass
class RetrievalOutcome:
    """检索阶段的产出：各模式的运行、越权扫描和越权数，供 all 子命令继续使用。"""

    report: dict[str, Any]
    markdown: Path
    data: Path
    violations: int


async def retrieval_phase(
    settings: Settings,
    engine: AsyncEngine,
    embedder: EmbeddingClient,
    chat: ChatClient,
    questions: Sequence[Question],
    identities: dict[str, Identity],
    manifest: dict[tuple[str, str], dict[str, str]],
    corpus: dict[str, int],
    modes: Sequence[str],
    *,
    sweep: bool,
    label: str,
    out: Path,
    store_in_db: bool,
) -> RetrievalOutcome:
    """Retrieval quality for each mode, and the permission sweep (every question as every role)."""
    reranker = LLMReranker(chat, settings.model_rerank, settings.rerank_passage_tokens)
    vectors, embedding_tokens = await embed_questions(
        embedder, questions, settings.embedding_batch_size
    )
    mode_runs = []
    for mode in modes:
        print(f"running {mode} ...", flush=True)
        mode_runs.append(
            await evaluate_mode(
                engine, settings, embedder, reranker if mode == "hybrid_rerank" else None,
                questions, identities, manifest, vectors, mode,
            )
        )  # fmt: skip
    swept = None
    if sweep:
        print("running the permission sweep ...", flush=True)
        swept = await leak_sweep(
            engine, settings, embedder, questions, identities, manifest, vectors
        )
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M")
    report = build_report(
        label=label, settings=settings, corpus=corpus, mode_runs=mode_runs, sweep=swept,
        embedding_tokens=embedding_tokens, rerank_model=settings.model_rerank,
        embedding_model=embedder.model,
    )  # fmt: skip
    markdown, data = write_reports(out, report, f"retrieval-{label}-{stamp}".replace("+", "_"))
    if store_in_db:
        for mode_run in mode_runs:
            await store_run(engine, mode_run, report)
    bad = sum(m["violations"] for m in report["modes"].values()) + (
        len(swept.violations) if swept else 0
    )
    return RetrievalOutcome(report, markdown, data, bad)


async def run_agent(args: argparse.Namespace) -> int:
    """代表性问题抽查子命令。"""
    from starit_eval import agent_check

    settings = get_settings()
    engine = create_engine(settings)
    corpus = await corpus_stats(engine)
    variants_spec = [("default", settings)]
    if args.compare_generate:
        variants_spec.append(
            (
                args.compare_generate.split("/")[-1],
                settings.model_copy(update={"model_generate": args.compare_generate}),
            )
        )
    calls = agent_check.estimate_calls(agent_check.CASES)
    per_variant = [
        agent_check.estimate_cost(s, calls, corpus["avg_tokens"], s.model_generate)
        for _, s in variants_spec
    ]
    total = (
        None
        if any(c is None for c in per_variant)
        else float(sum(c for c in per_variant if c is not None))
    )
    print(
        f"\nThis run asks {sum(len(c.turns) for c in agent_check.CASES)} questions per version, "
        f"{len(variants_spec)} version(s).\n"
        f"  model calls per version (upper bound): {calls['understand']} understand, "
        f"{calls['rerank']} rerank, {calls['generate']} generate\n"
        f"  estimated cost at list price: {'unknown' if total is None else f'about ${total:.3f}'}\n"
    )
    if not args.yes and not _proceed():
        print("Cancelled.")
        await engine.dispose()
        return 1
    identities = load_identities()
    results = []
    for label, variant_settings in variants_spec:
        print(f"asking with generate model {variant_settings.model_generate} ...", flush=True)
        results.append(
            await agent_check.run_variant(
                label,
                engine,
                variant_settings,
                embedding_client(variant_settings),
                chat_client(variant_settings),
                identities,
            )
        )
    path = agent_check.write(args.out, results, total)
    await engine.dispose()
    print(agent_check.summarize_for_console(results))
    print(f"report: {path}")
    return 0


async def run_data(args: argparse.Namespace) -> int:
    """数据题评测子命令。"""
    from starit_eval import data_check

    settings = get_settings()
    questions = data_check.load_data_questions()
    if args.only:
        questions = [q for q in questions if q.id in set(args.only)]
    calls, total = data_check.estimate(settings, questions)
    print(
        f"\nThis run asks {len(questions)} questions.\n"
        f"  model calls (upper bound, no retries): {sum(calls.values())} "
        f"({calls['understand']} understand, {calls['plan']} plan, {calls['sql']} sql, "
        f"{calls['answer']} answer)\n"
        f"  models: understand {settings.model_understand}, plan {settings.model_plan}, "
        f"sql {settings.model_sql}, answer {settings.model_generate}\n"
        f"  estimated cost at list price: {'unknown' if total is None else f'about ${total:.3f}'}\n"
    )
    if not args.yes and not _proceed():
        print("Cancelled.")
        return 1
    engine = create_engine(settings)
    run = await data_check.run_data_check(
        engine,
        settings,
        embedding_client(settings),
        chat_client(settings),
        data_check.load_askers(),
        questions,
    )
    path = data_check.write(args.out, run, total)
    await engine.dispose()
    print(data_check.summarize_for_console(run))
    print(f"report: {path}")
    return 0


def _calls_line(calls: dict[str, int]) -> str:
    """把 {步骤: 次数} 格式化成一行文字。"""
    return ", ".join(f"{n} {step}" for step, n in calls.items())


async def run_answers_command(args: argparse.Namespace) -> int:
    """答案评测子命令：估算、确认、跑 114 道文档题、写报告、抽查表和数据库记录。"""
    from starit_eval import answers

    settings = get_settings()
    questions = load_questions()
    if args.only:
        questions = [q for q in questions if q.id in set(args.only)]
    engine = create_engine(settings)
    corpus = await corpus_stats(engine)
    calls, total = answers.estimate(settings, questions, corpus["avg_tokens"])
    print(
        f"\nThis run asks {len(questions)} document questions.\n"
        f"  model calls (upper bound, no retries): {_calls_line(calls)}\n"
        f"  estimated cost at list price: {'unknown' if total is None else f'about ${total:.3f}'}\n"
    )
    if not args.yes and not _proceed():
        print("Cancelled.")
        await engine.dispose()
        return 1
    chat = answers.UsageChat(chat_client(settings))
    run = await answers.run_answers(
        engine, settings, embedding_client(settings), chat, load_identities(), questions,
        progress=lambda i, n: print(f"  {i}/{n}", end="\r", flush=True),
    )  # fmt: skip
    summary = answers.summarize(run)
    path = answers.write(args.out, run, summary, total)
    if not args.no_db:
        from starit_eval.report import git_sha

        await answers.store(engine, run, summary, git_sha(), "answers")
    await engine.dispose()
    print(f"{summary['passed']}/{summary['questions']} passed; report: {path}")
    return 0


async def run_all(args: argparse.Namespace) -> int:
    """全部评测：检索 + 越权扫描 + 答案 + 数据题，合成一份总报告；有越权则整体失败。"""
    from starit_eval import answers, data_check, suite
    from starit_eval.report import git_sha

    settings = get_settings()
    engine = create_engine(settings)
    questions, identities, manifest = load_questions(), load_identities(), load_manifest()
    data_questions = data_check.load_data_questions()
    corpus = await corpus_stats(engine)

    retrieval_figures = estimate(settings, questions, list(MODES), True, corpus["avg_capped"])
    answer_calls, answer_usd = answers.estimate(settings, questions, corpus["avg_tokens"])
    data_calls, data_usd = data_check.estimate(settings, data_questions)
    usd = [retrieval_figures["usd"], answer_usd, data_usd]
    total = None if any(u is None for u in usd) else float(sum(u for u in usd if u is not None))
    print(
        f"\nThe full evaluation: {len(questions)} document questions and {len(data_questions)} data "
        f"questions.\n"
        f"  retrieval (4 modes): {retrieval_figures['embedding_tokens']} embedding tokens, "
        f"{retrieval_figures['rerank_calls']} rerank calls (the {retrieval_figures['sweep_queries']} "
        f"permission-sweep queries only read the database)\n"
        f"  answers (upper bound): {_calls_line(answer_calls)}\n"
        f"  data (upper bound): {_calls_line(data_calls)}\n"
        f"  estimated cost at list price: {'unknown' if total is None else f'about ${total:.3f}'}\n"
    )
    if not args.yes and not _proceed():
        print("Cancelled.")
        await engine.dispose()
        return 1

    embedder = embedding_client(settings)
    chat = answers.UsageChat(chat_client(settings))
    print("== retrieval and permissions", flush=True)
    retrieval = await retrieval_phase(
        settings, engine, embedder, chat, questions, identities, manifest, corpus, list(MODES),
        sweep=True, label="full", out=args.out, store_in_db=not args.no_db,
    )  # fmt: skip
    print("== answers", flush=True)
    answer_chat = answers.UsageChat(chat_client(settings))
    answer_run = await answers.run_answers(
        engine, settings, embedder, answer_chat, identities, questions,
        progress=lambda i, n: print(f"  {i}/{n}", end="\r", flush=True),
    )  # fmt: skip
    answer_summary = answers.summarize(answer_run)
    answers_path = answers.write(args.out, answer_run, answer_summary, answer_usd)
    print("== data questions", flush=True)
    data_run = await data_check.run_data_check(
        engine, settings, embedder, chat_client(settings), data_check.load_askers(), data_questions
    )
    data_summary = data_check.summarize(data_run)
    data_path = data_check.write(args.out, data_run, None)
    if not args.no_db:
        await answers.store(engine, answer_run, answer_summary, git_sha(), "full")
        await data_check.store(engine, data_run, git_sha(), "full")
    sweep = retrieval.report.get("leak_sweep")
    sweep_checked = sweep["checked"] if sweep else None
    path = args.out / f"full-{datetime.now(UTC).strftime('%Y%m%d-%H%M')}.md"
    path.write_text(
        suite.render_all(
            retrieval=retrieval.report, permission_violations=retrieval.violations,
            sweep_checked=sweep_checked, answers=answer_summary, data=data_summary,
            files={"检索": retrieval.markdown, "答案": answers_path, "数据题": data_path},
            corpus=corpus, questions=len(questions),
            models={
                "understand": settings.model_understand, "rerank": settings.model_rerank,
                "generate": settings.model_generate, "judge": settings.model_judge,
                "plan": settings.model_plan, "sql": settings.model_sql,
            },
            git_sha=git_sha(),
        ),
        encoding="utf-8",
    )  # fmt: skip
    await engine.dispose()
    print(f"report: {path}")
    if retrieval.violations:
        print(f"PERMISSION VIOLATIONS: {retrieval.violations}", file=sys.stderr)
        return 2
    return 0


async def run_matrix_command(args: argparse.Namespace) -> int:
    """对比实验子命令：估算、确认、在临时数据库里跑所有实验。"""
    from starit_eval import matrix

    settings = get_settings()
    questions = load_questions()
    experiments = [e for e in matrix.EXPERIMENTS if not args.only or e.name in set(args.only)]
    engine = create_engine(settings)
    corpus = await corpus_stats(engine)
    await engine.dispose()
    figures = matrix.estimate(settings, questions, corpus["chunks"], corpus["avg_tokens"])
    embed_usd = cost_usd(settings.embedding_model, int(figures["embedding_tokens"]))
    derive_usd = cost_usd(
        settings.model_derive,
        int(figures["derive_input_tokens"]),
        int(figures["derive_output_tokens"]),
    )
    total = None if embed_usd is None or derive_usd is None else embed_usd + derive_usd
    print(
        f"\nThe experiment matrix: {len(experiments)} experiments, "
        f"{figures['ingests']} ingestions of the sample documents into a scratch database.\n"
        f"  embeddings: about {figures['embedding_tokens']} tokens\n"
        f"  derived content: up to {figures['derive_calls']} calls to {settings.model_derive}\n"
        f"  estimated cost at list price: {'unknown' if total is None else f'about ${total:.3f}'}\n"
    )
    if not args.yes and not _proceed():
        print("Cancelled.")
        return 1
    results = await matrix.run_matrix(
        settings, embedding_client(settings), chat_client(settings), questions, experiments,
        progress=lambda message: print(f"  {message}", flush=True),
    )  # fmt: skip
    note = "" if total is None else f"运行前估算费用约 {total:.3f} 美元。"
    path = matrix.write(
        args.out, results,
        {"embedding": settings.embedding_model, "derive": settings.model_derive}, note,
    )  # fmt: skip
    print(f"report: {path}")
    return 0


def main(argv: Sequence[str] | None = None) -> None:
    """命令行入口：解析参数并运行对应子命令，退出码交给 sys.exit。"""
    args = parse_args(argv)
    runner = {
        "agent": run_agent,
        "data": run_data,
        "answers": run_answers_command,
        "all": run_all,
        "matrix": run_matrix_command,
    }.get(args.command, run_retrieval)
    sys.exit(asyncio.run(runner(args)))


if __name__ == "__main__":
    main()
