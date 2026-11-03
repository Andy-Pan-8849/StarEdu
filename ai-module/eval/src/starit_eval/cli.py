"""Command line: `starit-eval retrieval --all-modes --leak-sweep`.

A real run calls hosted models (question embeddings, and reranking in hybrid_rerank mode), so
it first prints how many calls and tokens that will be and what they should cost, and asks.
"""

import argparse
import asyncio
import sys
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine
from starit_core.config import Settings, get_settings
from starit_core.db import create_engine
from starit_core.embeddings import EmbeddingClient, embedding_client
from starit_core.ingest.tokens import count_tokens
from starit_core.llm import ChatClient, LiteLLMChatClient
from starit_core.retrieval import MODES
from starit_core.retrieval.rerank import LLMReranker

from starit_eval.dataset import AI_MODULE, Question, load_identities, load_manifest, load_questions
from starit_eval.pricing import cost_usd
from starit_eval.report import build_report, store_run, write_reports
from starit_eval.runner import embed_questions, evaluate_mode, leak_sweep

DEFAULT_OUT = AI_MODULE.parent / "docs" / "eval"
RERANK_OVERHEAD_TOKENS = 160  # the instructions and the question
PASSAGE_HEADER_TOKENS = 40  # "[3] HR-REC-001 v2.1 (active) - title - section"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
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
    args = parser.parse_args(argv)
    if args.command == "retrieval" and not (args.mode or args.all_modes or args.leak_sweep):
        parser.error("choose --mode, --all-modes or --leak-sweep")
    return args


async def corpus_stats(engine: AsyncEngine) -> dict[str, int]:
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
    """Upper-bound token counts for the calls a run will make."""
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
    return input("Proceed? [y/N] ").strip().lower() in ("y", "yes")


def _confirm(args: argparse.Namespace, figures: dict[str, float | int | None]) -> bool:
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
        chat = LiteLLMChatClient()
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
    sweep = None
    if args.leak_sweep:
        print("running the permission sweep ...", flush=True)
        sweep = await leak_sweep(
            engine, settings, embedder, questions, identities, manifest, vectors
        )

    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M")
    label = args.label or ("dry-run" if args.dry_run else "+".join(modes) or "leak-sweep")
    report = build_report(
        label=label, settings=settings, corpus=corpus, mode_runs=mode_runs, sweep=sweep,
        embedding_tokens=embedding_tokens, rerank_model=settings.model_rerank,
        embedding_model=embedder.model,
    )  # fmt: skip
    markdown, data = write_reports(args.out, report, f"retrieval-{label}-{stamp}".replace("+", "_"))
    if not args.no_db and not args.dry_run:
        for mode_run in mode_runs:
            await store_run(engine, mode_run, report)
    await engine.dispose()
    print(f"report: {markdown}\ndata:   {data}")
    bad = sum(m["violations"] for m in report["modes"].values()) + (
        len(sweep.violations) if sweep else 0
    )
    if bad:
        print(f"PERMISSION VIOLATIONS: {bad}", file=sys.stderr)
        return 2
    return 0


async def run_agent(args: argparse.Namespace) -> int:
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
                LiteLLMChatClient(),
                identities,
            )
        )
    path = agent_check.write(args.out, results, total)
    await engine.dispose()
    print(agent_check.summarize_for_console(results))
    print(f"report: {path}")
    return 0


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    runner = run_agent if args.command == "agent" else run_retrieval
    sys.exit(asyncio.run(runner(args)))


if __name__ == "__main__":
    main()
