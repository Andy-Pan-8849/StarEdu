# AI Module

Enterprise knowledge assistant and Agent application for the fictional company StarIT Education.

Status: **milestones M2 to M9 are done and tagged** (`ai-m2` … `ai-m9`, plus `v0.1.0`). Everything below runs locally with Docker Compose. The business module is not started.

## What works today

| Area | What you get |
|---|---|
| Knowledge base | 28 sample documents (md, txt, docx, pdf) are parsed, cleaned, chunked, embedded and stored in PostgreSQL + pgvector by a background worker. Re-running changes only what changed. |
| Search | Keyword + vector search fused with RRF, then a model reranker. The permission filter runs inside the database query, before ranking. |
| Assistant (LangGraph) | Understands the question, asks one clarifying question when a detail is really missing, refuses out-of-scope or write requests, answers document questions with `[n]` citations, answers data questions ("how many tickets are open on my campus?") through read-only SQL views and an MCP server, and checks each answer against its sources (one retry). Fixed, non-leaking replies for "not found" and "no permission". |
| Streaming | `Accept: text/event-stream` gives Server-Sent Events. The answer is shown as it is written; if verification fails the draft is withdrawn (`message.retract`) and a corrected answer follows. |
| Access control | Keycloak logins with eight demo roles. Documents and data rows are filtered by role, campus and level; every run is written to an append-only audit log. |
| Models | All calls go through the LiteLLM gateway. Fallback chain `openai/gpt-6-luna` → `openai/gpt-4o-mini` → `anthropic/claude-haiku-5-5`. |
| Limits | Per user 20 messages/min, per IP 60/min, and a whole-stack budget of **0.5 USD per UTC day** (chat gets 429, the worker pauses). All adjustable in `.env`. |
| Web app | Next.js chat with citation viewer, conversation list, and a `Documents` admin page (upload, status, permissions, delete) for the `RAGETLAdmin` role. |
| Observability (optional) | OpenTelemetry traces, Prometheus metrics, Grafana dashboards, and Langfuse. |
| Evaluation | 114 document questions, 41 data questions, a permission leak sweep, retrieval-mode and chunking experiments. Latest answer run: **107/114** (the M8 baseline was 99/114); a 20% human review agreed with the model judge on 21 of 23 items. |

## Quick start (about 15 minutes the first time)

**You need:** Docker with Compose (give it at least 8 GB of memory and 20 GB of disk), [uv](https://docs.astral.sh/uv/), `make`, and Node 20+ only if you want to run the front-end checks.

```bash
cd ai-module
make env                 # creates .env from .env.example
```

Edit `.env` and set `OPENAI_API_KEY=` (needed to ask questions; `ANTHROPIC_API_KEY=` is only used by the last link of the fallback chain). Then:

```bash
make sync                # Python dependencies
make up                  # builds and starts everything, waits until healthy
make seed                # sample business tables + knowledge base from a prepared dump
                         # (no model key needed) + the original files
```

Check that it is alive:

```bash
curl http://localhost:8000/healthz
docker compose --env-file .env -f deploy/compose/compose.yaml ps
```

| Address | What |
|---|---|
| <http://localhost:3000> | the web app |
| <http://localhost:8000/docs> | API (OpenAPI) |
| <http://localhost:8080> | Keycloak admin (`admin` / `admin`) |
| <http://localhost:4100> | LiteLLM gateway |

Optional: `make up-obs` adds Grafana at <http://localhost:3300> (`admin` / `admin`); `make up-langfuse` adds Langfuse at <http://localhost:3100> (heavy, about 5 GB of memory in total). Stop with `make down` (keeps data) or `make clean` (deletes data).

## Try it

1. Open <http://localhost:3000> and sign in as `wei.stu.sh` (password `demo-pass-123`, all demo accounts use it).
2. Ask, and watch the answer stream in:

| Ask | Account | Expect |
|---|---|---|
| What does ERR-PORTAL-429 mean? | `wei.stu.sh` | an answer with a `[1]` you can click to read the source passage |
| How much is the referral bonus for an instructor? | `ning.adm.bj` | CNY 3,000, citing the active policy version |
| What was the referral bonus under the old policy? | `ning.adm.bj` | CNY 2,000 (v1.0, superseded) and the current v2.1 |
| How much can I claim? | `ning.adm.bj` | one clarifying question (which expense category?) |
| What is the weather today? | any | a polite refusal |
| What is the base salary band for a Senior Instructor at a Tier 1 campus? | `qing.hr.bj` | the band, with a citation |
| Same salary question | `wei.stu.sh` | a fixed "no permission / not found" reply that says nothing about the document |
| Delete my last ticket | any | refused (writes are not supported yet) |
| How many hotel claims exceed the nightly hotel limit in FIN-REIM-002? | `ning.fin.bj` | 5, built from the data views (the citation shows which views and how many rows) |
| A question about other people's expense claims | `wei.stu.sh` | nothing from other people's records |

3. Sign in as `min.ragetl.bj` and open **Documents**: upload a file with access rules, watch it go `queued` → `ready`.
4. API route (no browser), including streaming:

```bash
TOKEN=$(make -s token ACCOUNT=wei.stu.sh)
CID=$(curl -s -X POST localhost:8000/conversations -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
curl -N -X POST localhost:8000/conversations/$CID/messages \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d '{"content": "What does ERR-PORTAL-429 mean?"}'
```

Without the `Accept` header you get the whole reply as JSON. Every run is stored in `ai.runs`, `ai.messages` and `ai.audit_log`.

## How to check it

Free (no model calls):

```bash
make lint            # ruff + mypy (strict)
make test            # about 875 Python tests; integration tests run when `make up` is running
make web-check       # front end: lint, types, 62 unit tests, production build
make e2e             # Playwright browser tests (needs `make up`; uploads use fake embeddings)
```

Paid (each prints the number of model calls and the estimated cost, then asks before running):

```bash
make eval ARGS="answers"      # 114 document questions, graded; about 0.14 USD; report in docs/eval/
make eval ARGS="agent"        # 15 representative questions incl. clarification and permissions; about 0.01 USD
make eval ARGS="data"         # 41 data questions
make eval ARGS="all"          # everything in one report
```

Things worth trying on purpose:

- **Fallback chain:** `uv run python scripts/m9_real_check.py fallback` (a few cents) asks through the gateway with an invalid primary model, then with two invalid models; it should print `openai/gpt-4o-mini` and then `anthropic/claude-haiku-5-5` as the model that actually answered. In the app, the model that answered is recorded in the run's trace and in `fallbacks` of its audit entry.
- **Daily budget:** set `STARIT_DAILY_BUDGET_USD=0.001`, `make up`, ask two questions: the second gets HTTP 429 with the reset time.
- **Rate limit:** send more than 20 messages in a minute from one account to get 429.
- **Permissions:** ask the same question as `wei.stu.sh` and as `qing.hr.bj`; `make eval ARGS="retrieval --all-modes --leak-sweep"` asks every question as every role and must report zero leaks.
- **Traces:** with `make up-obs`, copy a `run_id` from `ai.runs` and search it in Grafana → Explore → Tempo: `{ span.run_id = "<run id>" }`.

Results of past runs and the human-review sheet are in [`../docs/eval/`](../docs/eval/); what each milestone delivered, and what it did not, is in [`../docs/design/08-milestone-checklists.md`](../docs/design/08-milestone-checklists.md). What comes next (and what was left out on purpose) is in [`../docs/design/09-phase2-plan.md`](../docs/design/09-phase2-plan.md).

Known limits: single language (English) data; no memory across conversations; no write actions; the IP limit cannot tell browsers apart in local Docker (all look like the Docker gateway) unless `STARIT_TRUSTED_PROXIES` is set behind a proxy; the first run downloads a tokenizer vocabulary, so it needs internet once.

## Development setup (milestone M0)

Prerequisites: [uv](https://docs.astral.sh/uv/), Docker with Compose, and `make`. Python 3.12 is pinned in `.python-version`; uv installs it if needed.

```bash
cd ai-module
make sync      # install dependencies
make up        # start Postgres (pgvector), Redis, object storage, Keycloak, the LiteLLM
               # gateway, the API, the worker, the MCP server and the web app
               # (a one-shot container applies the database migrations first)
make seed      # the sample business tables + the knowledge base from a prepared dump
               # (no model key needed) + the original files of the sample documents
make test      # unit tests, plus integration tests when the services are up
make lint      # ruff and mypy
curl http://localhost:8000/healthz
```

Only a model key is needed to *ask questions* (`OPENAI_API_KEY` in `.env`, read by the LiteLLM
gateway container). `make seed` itself needs none. To build the knowledge base with the real
ingestion pipeline instead of the dump (this calls the embedding model), use
`make seed ARGS=--ingest`, or `make ingest-samples ARGS="--wait"`. After a real ingestion,
`make seed-dump` rewrites `seed/ai-seed.jsonl.gz`.

### Models, gateway and keys

In Compose, `api`, `worker` and `mcp-server` call models through the **LiteLLM gateway**
(`STARIT_LLM_GATEWAY=litellm_proxy`); only the `litellm` container holds the provider keys, and
`deploy/litellm/config.yaml` forwards any `openai/*` or `anthropic/*` model, so changing a model
is a setting. Run on the host (`uv run`, the evaluation) the keys are used directly
(`litellm_lib`, the default). The services authenticate to the gateway with `LITELLM_MASTER_KEY`
(a local default in `.env.example`; change it before exposing the port).

### Traces, metrics and Langfuse (optional)

```bash
make up-obs        # + OpenTelemetry Collector, Tempo, Prometheus, Grafana  -> http://localhost:3300
make up-langfuse   # + Langfuse (heavy: web, worker, ClickHouse, ...)       -> http://localhost:3100
```

Grafana (`admin` / `admin`) has four dashboards in the StarEdu folder: run overview, how runs
end, retrieval and model latency, document ingestion. Every assistant run is one trace: the HTTP
request, each step of the graph, each model call, each database statement and, for a data
question, the call into the MCP server. Find a run by its id in Grafana's Explore (Tempo,
TraceQL: `{ span.run_id = "<run id>" }`). Logs are JSON with `request_id`, `run_id` and
`trace_id`. Spans carry ids, model names, token counts and timings; **not** the bearer token and
not the question or answer text (set `STARIT_OTEL_CAPTURE_CONTENT=true` to add them, which you
should not do with real data). Langfuse (`admin@starit.example` / `starit-local`, local only)
receives the same traces; the model calls appear as generations. With the core stack alone
nothing is recorded or exported. Measured memory: core about 2.1 GiB, with observability about
3.0 GiB, with Langfuse about 5.4 GiB (docs/design/06, section 11).

### Demo accounts (local only)

`make up` also starts Keycloak with a demo realm (`starit`). All accounts use the password `demo-pass-123`. They exist only for local demos; never reuse them or the password anywhere else.

| Account | Role | Who in the sample data |
|---|---|---|
| `wei.stu.sh` | student | student S0018, Shanghai |
| `ning.adm.bj`, `wei.acad.sh` | staff | Admissions Advisor (Beijing), Instructor (Shanghai) |
| `ling.mgr.bj`, `peng.mgr.sh` | manager | Campus Directors of Beijing and Shanghai |
| `qing.hr.bj` | hr | HR Business Partner, headquarters (Beijing) |
| `ning.fin.bj` | finance | Finance Controller, headquarters |
| `tao.admin.bj` | Admin | Helpdesk Engineer, headquarters |
| `min.ragetl.bj` | RAGETLAdmin | Principal Instructor, headquarters |

The name is `<given name>.<function>.<campus>`. Each account is a real person in the sample CSV tables, so "own records" and "own campus" can be tested; see [`sample-data/README.md`](sample-data/README.md).

```bash
curl -H "Authorization: Bearer $(make -s token ACCOUNT=wei.acad.sh)" localhost:8000/me
```

The Keycloak admin console is at http://localhost:8080 (user `admin`, password `admin`, set in `.env`). The realm file is `deploy/compose/keycloak/starit-realm.json`; it enables the password grant for the `starit-web` client so scripts and tests can fetch tokens, which a real deployment should turn off.

### Ingesting documents

`make ingest-samples` stores the original files in object storage, records each document with its access rules and queues an ingestion job. The `worker` container takes the jobs, one document at a time: parse (md, txt, docx, pdf), clean, chunk, embed and store, replacing the document's old chunks in one transaction. Running it again changes only what changed; `ARGS="--force"` queues every document again, which is how you re-embed after changing the embedding model.

Embeddings need `OPENAI_API_KEY` in `.env` (the model is `EMBEDDING_MODEL`, 1536 dimensions). For a free dry run with meaningless vectors set `EMBEDDING_PROVIDER=fake`. A failed job shows its stage and reason in `ai.ingestion_jobs` (`stage`, `error_code`, `error_message`). The first run downloads the tokenizer vocabulary, so it needs internet access once.

### Retrieval and evaluation

Retrieval lives in `starit_core.retrieval`: `retrieve(conn, identity, query, mode=...)` with four modes (`keyword`, `vector`, `hybrid`, `hybrid_rerank`). There is no way to search without an identity, and the permission filter is applied inside the database query before ranking.

`make eval` runs the evaluation (`eval/`). A real run calls hosted models, so it first prints how many calls and tokens that is and what it should cost, then asks:

```bash
make eval ARGS="retrieval --all-modes --leak-sweep"        # four modes + every question as every role
make eval ARGS="retrieval --mode hybrid --label try-1"     # one mode
make eval ARGS="retrieval --all-modes --dry-run"           # fake models, no cost, the numbers mean nothing
make eval ARGS="all"          # retrieval, permissions, answers and data questions in one report
make eval ARGS="answers"      # the 114 document questions, graded (facts, a model judge, refusals)
make eval ARGS="matrix"       # chunk size, identifier weighting, derived content (scratch database)
```

Reports go to `docs/eval/` (see the baseline there) and each mode's run is recorded in `ai.eval_runs` / `ai.eval_results`. The rerank model is `STARIT_MODEL_RERANK` (default `openai/gpt-6-luna`).

### Chatting with the assistant

With the stack up (`make up`), get a demo token and talk to the API:

```bash
TOKEN=$(make -s token ACCOUNT=wei.stu.sh)
CID=$(curl -s -X POST localhost:8000/conversations -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
curl -s -X POST localhost:8000/conversations/$CID/messages \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"content": "What does ERR-PORTAL-429 mean?"}'
```

The reply carries the answer with `[n]` citations, the `end_state` (`answered`, `need_clarification`, `no_permission`, `not_found`, `refused` or `error`) and an `end_reason`. Every run is recorded in `ai.runs`, `ai.messages` and the audit log. Users are limited to 20 messages a minute (`STARIT_RATE_LIMIT_CHAT_PER_MINUTE`). `make eval ARGS="agent --compare-generate openai/gpt-4o-mini"` asks a set of representative questions for real and reports what happens (it prints the estimated cost and asks first).

### Documents and the web app

The web app (`web/`, Next.js 15) is part of the stack: after `make up`, open <http://localhost:3000> and sign in with a demo account. Everyone gets the assistant: ask a question, and click a `[n]` in the answer to read the source passage (or, for an answer built from business data, which views and how many rows it used). The `Documents` page appears only for `RAGETLAdmin` (`min.ragetl.bj`): upload a file with its access rules, watch it go from `queued` to `ready` (or see why it failed), edit its metadata and permissions, queue it again, or delete it. The API checks the role on every request; the menu is only a convenience.

```bash
make web-dev      # the front end with hot reload on :3000 (the API from `make up` on :8000)
make web-check    # lint, types, formatting, unit tests and a production build
make e2e          # browser smoke tests with Playwright (needs `make up`; installs Chromium on first use)
```

`make e2e` switches the worker to fake embeddings while it runs, so uploading costs nothing. The browser talks to the API directly, so the API allows the web origin (`STARIT_CORS_ORIGINS`), and the front end reads its addresses from `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_OIDC_AUTHORITY` and `NEXT_PUBLIC_OIDC_CLIENT_ID` (set at build time).

### Database accounts

Three Postgres accounts are used, so that grants and the append-only audit log mean something:

| Account | Used for | Notes |
|---|---|---|
| `starit` | migrations and seeding | the database owner; the application never uses it |
| `ai_app` | the application | ordinary privileges; may only insert into the audit log |
| `ai_sql_ro` | SQL Agent queries | cannot log in; the application switches to it inside a transaction, and it can read only the whitelisted `ai_sql` views, which filter rows by the caller's identity |

If you already have an `.env` from an earlier milestone, copy the new variables from `.env.example` (`STARIT_APP_DB_PASSWORD`, `STARIT_MIGRATION_DATABASE_URL`, `EMBEDDING_*`) and set `STARIT_DATABASE_URL` to the `ai_app` URL. After the demo accounts change, run `make clean` once so Keycloak imports the new realm (this removes local demo data only).

The services use the usual default ports (Postgres 5432, Redis 6379, object storage 9000/9001, API 8000). If one is taken on your machine, change it in `.env` (created from `.env.example` by `make up`). `make down` stops the services and keeps the data; `make clean` also deletes the data volumes.

The design documents are in [`../docs/design/`](../docs/design/).

The job levels used in the sample data (I, S and M ladders and the 1 to 7 grade), the demo accounts and the data-scope rules are explained in [`sample-data/README.md`](sample-data/README.md).
