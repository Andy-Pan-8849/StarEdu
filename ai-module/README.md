# AI Module

Enterprise knowledge assistant and Agent application for the fictional company StarIT Education.

Status: **no application code yet.** Only the sample data exists. See the top-level [README](../README.md) for the decisions made so far.

Planned content (proposal, not yet approved):

- RAG ETL pipeline: pluggable parsers, cleaning, chunking, embeddings, pgvector.
- Hybrid search: keyword search plus vector search, fused with RRF, then reranking.
- Agents: router, RAG agent, SQL agent, action agent, guardrails, MCP server.
- FastAPI service with streaming chat, Next.js front end.

Folders:

| Folder | Purpose |
|---|---|
| `sample-data/` | Synthetic company documents, structured data and evaluation questions |

## Development setup (milestone M0)

Prerequisites: [uv](https://docs.astral.sh/uv/), Docker with Compose, and `make`. Python 3.12 is pinned in `.python-version`; uv installs it if needed.

```bash
cd ai-module
make sync      # install dependencies
make up        # start Postgres (pgvector), Redis, object storage, Keycloak and the API
               # (a one-shot container applies the database migrations first)
make seed-biz  # load the sample business tables into the biz schema
make ingest-samples ARGS="--wait"   # register the 28 sample documents; the worker container
                                     # parses, chunks, embeds and stores them
make test      # unit tests, plus integration tests when the services are up
make lint      # ruff and mypy
curl http://localhost:8000/healthz
```

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
