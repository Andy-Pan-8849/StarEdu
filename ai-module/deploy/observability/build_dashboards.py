"""Writes the four Grafana dashboards (grafana/dashboards/*.json) from the queries below.

The dashboards are generated so a metric name is written once. Run: python3 build_dashboards.py
The names are the ones Prometheus really holds: the Collector turns `starit.runs` into
`starit_runs_total`, and a histogram `starit.llm.duration` (seconds) into
`starit_llm_duration_seconds_*`.
"""

import json
from pathlib import Path
from typing import Any

OUT = Path(__file__).resolve().parent / "grafana" / "dashboards"
PROM = {"type": "prometheus", "uid": "prometheus"}
TEMPO = {"type": "tempo", "uid": "tempo"}


def target(expr: str, legend: str = "", *, instant: bool = False, ref: str = "A") -> dict[str, Any]:
    return {
        "datasource": PROM, "expr": expr, "legendFormat": legend, "refId": ref,
        "instant": instant, "range": not instant,
    }  # fmt: skip


def panel(
    kind: str,
    title: str,
    targets: list[dict[str, Any]],
    x: int,
    y: int,
    w: int,
    h: int,
    unit: str = "short",
    description: str = "",
    **extra: Any,
) -> dict[str, Any]:  # noqa: PLR0913
    return {
        "type": kind, "title": title, "description": description, "datasource": PROM,
        "targets": targets, "gridPos": {"x": x, "y": y, "w": w, "h": h}, "id": 0,
        "fieldConfig": {"defaults": {"unit": unit}, "overrides": []}, **extra,
    }  # fmt: skip


def stat(
    title: str, expr: str, x: int, y: int, w: int = 6, unit: str = "short", description: str = ""
) -> dict[str, Any]:
    return panel("stat", title, [target(expr, instant=True)], x, y, w, 4, unit, description,
                 options={"reduceOptions": {"calcs": ["lastNotNull"]}, "colorMode": "none"})  # fmt: skip  # noqa: E501


def series(
    title: str,
    targets: list[dict[str, Any]],
    x: int,
    y: int,
    w: int = 12,
    h: int = 8,
    unit: str = "short",
    description: str = "",
) -> dict[str, Any]:
    return panel("timeseries", title, targets, x, y, w, h, unit, description)


def quantile(q: float, metric: str, by: str, window: str = "5m") -> str:
    return f"histogram_quantile({q}, sum by (le, {by}) (rate({metric}_bucket[{window}])))"


def chat_quantile(q: float) -> str:
    selector = (
        'http_server_duration_milliseconds_bucket{http_target=~".*/messages",http_method="POST"}'
    )
    return f"histogram_quantile({q}, sum by (le) (rate({selector}[5m])))"


def dashboard(
    uid: str, title: str, panels: list[dict[str, Any]], description: str
) -> dict[str, Any]:
    for number, p in enumerate(panels, start=1):
        p["id"] = number
    return {
        "uid": uid, "title": title, "description": description, "tags": ["starit"],
        "schemaVersion": 39, "version": 1, "editable": True, "refresh": "10s",
        "time": {"from": "now-1h", "to": "now"}, "timezone": "browser",
        "templating": {"list": []}, "annotations": {"list": []}, "panels": panels,
    }  # fmt: skip


RUNS = "starit_runs_total"
LLM = "starit_llm"

overview = dashboard(
    "starit-overview",
    "StarEdu: run overview",
    [
        stat(
            "Runs (selected range)",
            f"sum(increase({RUNS}[$__range]))",
            0,
            0,
            description="Assistant runs, all end states",
        ),
        stat(
            "Error runs", f'sum(increase({RUNS}{{end_state="error"}}[$__range])) or vector(0)', 6, 0
        ),
        stat("Model calls", f"sum(increase({LLM}_calls_total[$__range]))", 12, 0),
        stat("Model tokens", f"sum(increase({LLM}_tokens_total[$__range]))", 18, 0),
        series(
            "Runs per minute by end state",
            [target(f"sum by (end_state) (increase({RUNS}[1m]))", "{{end_state}}")],
            0,
            4,
        ),
        series(
            "HTTP requests per second by route",
            [
                target(
                    "sum by (http_method, http_target) (rate(http_server_duration_milliseconds_count[1m]))",  # noqa: E501
                    "{{http_method}} {{http_target}}",
                )
            ],
            12,
            4,
            unit="reqps",
        ),
        series(
            "Chat request latency p50 / p95",
            [
                target(chat_quantile(0.5), "p50", ref="A"),
                target(chat_quantile(0.95), "p95", ref="B"),
            ],
            0,
            12,
            unit="ms",
            description="POST /conversations/{id}/messages: the whole run, as the user waits for it",  # noqa: E501
        ),
        series(
            "Data tool calls by result",
            [
                target(
                    "sum by (tool, result) (increase(starit_tool_calls_total[1m]))",
                    "{{tool}} {{result}}",
                )
            ],
            12,
            12,
        ),
        {
            "type": "table",
            "title": "Recent runs (Tempo)",
            "datasource": TEMPO,
            "id": 0,
            "gridPos": {"x": 0, "y": 20, "w": 24, "h": 8},
            "targets": [
                {
                    "datasource": TEMPO,
                    "queryType": "traceql",
                    "refId": "A",
                    "limit": 20,
                    "query": '{ name = "agent.run" }',
                }
            ],
            "description": "Open a trace to see every step of a run; the run id is the attribute run_id.",  # noqa: E501
            "fieldConfig": {"defaults": {}, "overrides": []},
        },
    ],
    "How the assistant is being used and how it ends.",
)

end_states = dashboard(
    "starit-end-states",
    "StarEdu: how runs end",
    [
        panel(
            "piechart",
            "End states (selected range)",
            [
                target(
                    f"sum by (end_state) (increase({RUNS}[$__range]))",
                    "{{end_state}}",
                    instant=True,
                )
            ],
            0,
            0,
            8,
            8,
            options={
                "reduceOptions": {"calcs": ["lastNotNull"]},
                "legend": {"displayMode": "table", "values": ["value"]},
            },
        ),
        panel(
            "table",
            "End state and reason",
            [target(f"sum by (end_state, end_reason) (increase({RUNS}[$__range]))", instant=True)],
            8,
            0,
            16,
            8,
            description="Reasons: restricted_document / restricted_data (no permission), no_relevant_documents / no_matching_rows (not found), out_of_scope, input_blocked, write_not_enabled (refused), llm_error, sql_failed, tool_error, step_limit (error).",  # noqa: E501
        ),
        series(
            "Runs per minute by end state (stacked)",
            [target(f"sum by (end_state) (increase({RUNS}[1m]))", "{{end_state}}")],
            0,
            8,
            24,
            9,
            description="A growing error band is the first thing to look at",
        ),
        series(
            "Share of runs that are not answered",
            [
                target(
                    f'1 - (sum(increase({RUNS}{{end_state="answered"}}[5m])) / sum(increase({RUNS}[5m])))',  # noqa: E501
                    "not answered",
                )
            ],
            0,
            17,
            12,
            8,
            unit="percentunit",
            description="Includes refusals and clarifications, which are normal; read it with the end-state table",  # noqa: E501
        ),
        series(
            "Model calls by outcome",
            [
                target(
                    f"sum by (model, outcome) (increase({LLM}_calls_total[1m]))",
                    "{{model}} {{outcome}}",
                )
            ],
            12,
            17,
            12,
            8,
        ),
    ],
    "Answered, needs clarification, no permission, not found, refused, error.",
)

latency = dashboard(
    "starit-latency",
    "StarEdu: retrieval and model latency",
    [
        series(
            "Retrieval latency p50 / p95 by mode",
            [
                target(
                    quantile(0.5, "starit_retrieval_duration_seconds", "mode"),
                    "p50 {{mode}}",
                    ref="A",
                ),
                target(
                    quantile(0.95, "starit_retrieval_duration_seconds", "mode"),
                    "p95 {{mode}}",
                    ref="B",
                ),
            ],
            0,
            0,
            unit="s",
        ),
        series(
            "Model call latency p50 / p95 by model",
            [
                target(
                    quantile(0.5, "starit_llm_duration_seconds", "model"), "p50 {{model}}", ref="A"
                ),
                target(
                    quantile(0.95, "starit_llm_duration_seconds", "model"), "p95 {{model}}", ref="B"
                ),
            ],
            12,
            0,
            unit="s",
        ),
        series(
            "Graph step latency p95 by step",
            [target(quantile(0.95, "starit_agent_node_duration_seconds", "node"), "{{node}}")],
            0,
            8,
            unit="s",
            description="Which step of the assistant takes the time",
        ),
        series(
            "Tokens per minute by model and direction",
            [
                target(
                    f"sum by (model, direction) (increase({LLM}_tokens_total[1m]))",
                    "{{model}} {{direction}}",
                )
            ],
            12,
            8,
        ),
        stat(
            "Restricted matches per retrieval",
            "sum(increase(starit_retrieval_restricted_hits_total[$__range])) / sum(increase(starit_retrieval_queries_total[$__range]))",  # noqa: E501
            0,
            16,
            12,
            description="How many matching passages the asker could not read, per search (a count, never their text). High means people ask about documents their role cannot see.",  # noqa: E501
        ),
        stat(
            "Retrievals (selected range)",
            "sum(increase(starit_retrieval_queries_total[$__range]))",
            12,
            16,
            12,
        ),
    ],
    "Where the time goes in a run.",
)

ingestion = dashboard(
    "starit-ingestion",
    "StarEdu: document ingestion",
    [
        series(
            "Jobs waiting in the queue",
            [target("max(starit_ingest_queue_length)", "queued")],
            0,
            0,
            8,
            8,
        ),
        stat(
            "Jobs finished (selected range)",
            'sum(increase(starit_ingest_jobs_total{status="succeeded"}[$__range])) or vector(0)',
            8,
            0,
            8,
        ),
        stat(
            "Jobs failed (selected range)",
            'sum(increase(starit_ingest_jobs_total{status="failed"}[$__range])) or vector(0)',
            16,
            0,
            8,
            description="A failed job leaves its document searchable as before; the reason is on the document page",  # noqa: E501
        ),
        series(
            "Jobs per minute by status",
            [target("sum by (status) (increase(starit_ingest_jobs_total[1m]))", "{{status}}")],
            0,
            8,
            12,
            8,
        ),
        {
            "type": "table",
            "title": "Recent ingestion jobs (Tempo)",
            "datasource": TEMPO,
            "id": 0,
            "gridPos": {"x": 12, "y": 8, "w": 12, "h": 8},
            "targets": [
                {
                    "datasource": TEMPO,
                    "queryType": "traceql",
                    "refId": "A",
                    "limit": 20,
                    "query": '{ name = "ingest.job" }',
                }
            ],
            "fieldConfig": {"defaults": {}, "overrides": []},
        },
    ],
    "Uploads becoming searchable.",
)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, board in (
        ("overview", overview),
        ("end-states", end_states),
        ("latency", latency),
        ("ingestion", ingestion),
    ):
        (OUT / f"{name}.json").write_text(json.dumps(board, indent=2) + "\n", encoding="utf-8")
        print("wrote", OUT / f"{name}.json")


if __name__ == "__main__":
    main()
