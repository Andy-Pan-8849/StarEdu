# Design document 06: deployment profiles, observability and engineering rules (AI module, phase 1)

[中文](06-deployment-profiles-and-engineering.chn.md)

Status: **Approved by the user (2026-11-02); all 6 confirmation points of section 9 were accepted.** The next step is the implementation plan; no application code is written before it is approved.
Depends on: 01 to 05. Marking convention: **[Decided]**, **[Proposed]**, **[Open]** (needs measuring).
**Note**: every memory figure in this document is a rough estimate, not measured, and must not be taken as a promise; it is filled in after measuring.

## 1. Service list of the two profiles

| Service | full (local Compose) | lite (Oracle k3s) | Notes |
|---|---|---|---|
| web (Next.js) | ✅ | ✅ | |
| api (FastAPI) | ✅ | ✅ | |
| worker | ✅ | ✅ | |
| mcp-server | ✅ | ✅ | |
| Postgres + pgvector | ✅ | ✅ | The ready-made pgvector image; the BM25 extension is not brought in for now (see 05) |
| Redis | ✅ | ✅ (single node) | Rate limiting and cache |
| Object store | MinIO | [Open] single-node MinIO or Oracle object storage | |
| Keycloak | ✅ | [Open] | See 3 |
| LiteLLM proxy | ✅ | ❌ (litellm library in the process) | See 4.2 of 01 |
| Langfuse | ✅ | ❌ | Many dependencies, local only |
| OTel Collector | ✅ | ✅ | |
| Prometheus, Grafana | ✅ | ✅ (slimmed down) | |
| Loki, Tempo | ✅ | [Open] depending on memory | |

## 2. The local full profile

### 2.1 Starting [Proposed]

- One `deploy/compose/` directory: `compose.yaml` (the core services) plus optional override files (`observability.yaml`, `langfuse.yaml`), combined by profile or multiple files, so **a learner can start only the core services**.
- `make up`, `make down`, `make seed` and similar wrappers are provided; every service has a health check, and the order of dependencies uses `depends_on: condition: service_healthy`.
- `.env.example` lists every variable with a note; the real `.env` stays out of Git. **The only thing the user must supply is the LLM API key** (OpenAI; Anthropic too when it is used).

### 2.2 Resources (rough estimates, to be measured)

Your machine is a 16 GB Mac. Setting Docker Desktop's memory limit to about 8 to 10 GB is the safe choice. A rough estimate of each part:

| Part | Rough estimate |
|---|---|
| Postgres | 0.3 to 0.5 GB |
| api + worker + mcp-server | about 0.2 to 0.4 GB each |
| web | about 0.3 GB |
| Keycloak | about 1 to 1.5 GB (the figure found in the requirements document) |
| Redis, MinIO | about 0.1 to 0.2 GB each |
| Prometheus, Grafana, Loki, Tempo, OTel | about 1 to 1.5 GB together |
| Langfuse (with the stores it depends on) | possibly over 2 GB, **not verified** |

**Measurements (M1, idle on the Mac, `docker stats`, 2026-11-02)**:

| Service | Measured memory |
|---|---|
| Keycloak (`start-dev`) | about 650 to 675 MiB, starting in about 10 seconds |
| api | about 70 MiB |
| Object store (pgsty/silo) | about 190 MiB |
| Postgres | about 32 MiB (empty database) |
| Redis | about 10 MiB |
| Total | about 1 GB |

Keycloak is lower than the rough 1 to 1.5 GB above; this is a development-mode, idle figure and will be higher under load.

The core services can run within 4 GB, with the full observability and Langfuse on top. **A learner can start layer by layer**, which is why 2.1 splits the optional components.

## 3. The lite profile (Oracle k3s)

- **One VM only, single-node k3s, two namespaces** [Decided]; the real Oracle quota is for you to verify (the "2 cores 12 GB" noted in the requirements document is an online report and not verified).
- Deployment uses a Helm chart, with variable names consistent with `.env` (secrets in a Secret).
- **Identity service** [Open]: the rule is "first measure Keycloak's memory use on that machine". Alternatives: Logto, or the api signs JWTs itself and publishes JWKS (the interface does not change, and the api and MCP still only verify JWKS). **Phase 1 finishes full first, and the identity plan of lite is scheduled separately in the implementation plan.**
- Public side: public IP + port, invented demo accounts, **no real data at all**; LLM calls get a **daily cost cap** to prevent abuse.
- lite goes live with a minimal set first: web, api, worker, mcp-server, Postgres, Redis, plus the identity service; observability is added step by step depending on memory.

## 4. Configuration and secrets [Proposed]

- Environment variables are the only source; variable names have the prefix `STARIT_`, grouped by component. Examples:

| Group | Variables (excerpt) |
|---|---|
| LLM | `STARIT_LLM_GATEWAY` (`litellm_proxy` / `litellm_lib`), `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, the model name of each node `STARIT_MODEL_UNDERSTAND`, `STARIT_MODEL_GENERATE`, `STARIT_MODEL_RERANK` |
| Embedding | `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` |
| Search | `STARIT_RETRIEVAL_MODE`, `STARIT_KEYWORD_SEARCHER`, the numeric parameters (see 2.1 of 05) |
| Identity | `STARIT_OIDC_ISSUER`, `STARIT_OIDC_AUDIENCE_API`, `STARIT_OIDC_AUDIENCE_MCP` |
| Limits | `STARIT_RATE_LIMIT_CHAT`, `STARIT_DAILY_LLM_BUDGET` |

- Secrets go only in `.env` or a Secret, and **never into the image, the log or the trace**; secrets and JWTs are masked in logs.

## 5. Sample data and seeding [Proposed]

1. `make seed` does three things: create the Keycloak realm, roles and test accounts; import `sample-data/structured/*.csv` into the `biz` schema and create the allow-listed views and the `ai_sql_ro` account; import the 28 documents through the ingestion interface of 05.
2. **A ready-made vector store dump** (an item left over from the requirements document): after ingestion, export the `ai` schema data (chunks, vectors, derived content) as a compressed SQL dump and put it in the repository's `seed/` or a release attachment. A learner can **see the search results without an OpenAI key** and re-ingest when using their own key. The dump records the embedding model and dimensions (the convention of 02), and at start-up a mismatch prompts re-ingestion.
3. The size of the dump needs evaluating (28 documents, not large); if it exceeds the GitHub limit it goes in a release attachment.

## 6. Observability [Proposed]

- All services are wired uniformly to OpenTelemetry: HTTP requests, the database, LLM calls and every node of the graph are spans; logs carry `request_id`, `run_id` and `trace_id`.
- Metrics (Prometheus): request volume and latency, the `end_state` distribution, search latency, LLM calls and tokens, ingestion queue length and failures, the share of chunks filtered out by permissions.
- Preset Grafana dashboards: run overview, End state distribution, search and LLM latency, ingestion jobs.
- Langfuse (full only): the trace of each run, prompt versions, evaluation scores.
- The audit log is in the database (3.4 of 02) and does not depend on the observability components.

## 7. Engineering rules [Proposed]

| Item | Choice |
|---|---|
| Python | uv, Python 3.12; Ruff for formatting and static checks; mypy or pyright for types (one is chosen at implementation); pytest for tests |
| Front end | TypeScript strict mode, ESLint, Prettier |
| Commit hooks | pre-commit: formatting, static checks, secret scanning (to keep `.env` and keys from being committed) |
| CI (GitHub Actions) | On every commit: Python and front-end checks, unit and graph structure tests (fake LLM), migrations that run on an empty database; **no evaluation with a real LLM** |
| Database migrations | Alembic; every migration runs on an empty and on an existing database; verified in CI |
| Dependencies | uv's lock file goes into Git; Docker image version tags are pinned |
| Branches and commits | Protected main branch; small commits with messages that say why; a tag when each phase completes |
| License | MIT; the licenses of dependencies must be compatible (see the note on the PDF library in 05) |

## 8. Acceptance criteria of phase 1 [Proposed]

1. `make up && make seed` runs through on a clean Mac, needing only the LLM key.
2. After signing in with each role's account, asking on the chat page gives an answer with citations or a clear refusal, and every run has an End state.
3. `RAGETLAdmin` can upload, change permissions, delete and re-ingest on the document management page, and sees the ingestion status and failure reasons.
4. **Permission regression fully passes** (4.3 of 05), and the `Admin` account cannot read restricted document content.
5. The evaluation command runs and produces a report that includes a comparison of search modes.
6. Langfuse and Grafana show the trace and metrics of the same run.
7. Unit and graph structure tests pass in CI.

## 9. Points for you to confirm

1. The layered start of 2.1 (core services / observability / Langfuse can start separately): accepted?
2. 3: phase 1 finishes full first, and the identity plan and deployment of lite are scheduled separately in the implementation plan: accepted?
3. The "ready-made vector store dump" of section 5: a learner can see the search results without an OpenAI key: accepted?
4. The observability scope of section 6: accepted?
5. The engineering rules of section 7 (Ruff, pre-commit, CI not running the real evaluation and so on): accepted?
6. Anything to add or remove in the acceptance criteria of section 8?

## 10. Confirmation results (2026-11-02)

All 6 points were accepted: layered start; full first in phase 1 with the identity plan of lite scheduled separately; the ready-made vector store dump; the observability scope; the engineering rules; the acceptance criteria.

## 11. M8 revision and measurements (2026-11-04)

### 11.1 Measured memory (Mac, Docker Desktop limit about 11.7 GiB, idle, `docker stats`)

| Service | Measured |
|---|---|
| Keycloak (`start-dev`) | about 730 MiB |
| LiteLLM proxy | about 580 to 590 MiB |
| Grafana | about 340 to 680 MiB |
| api | about 330 to 350 MiB |
| Object store (pgsty/silo) | about 220 to 250 MiB |
| Tempo | about 60 to 195 MiB |
| OTel Collector | about 70 to 120 MiB |
| worker | about 100 MiB |
| mcp-server | about 90 MiB |
| Postgres, Redis, Prometheus, web | about 60 + 10 + 50 + 40 MiB |
| **Core services in total (with LiteLLM)** | **about 2.1 GiB** |
| **Core + observability (Collector, Tempo, Prometheus, Grafana, about 0.85 GiB)** | **about 3.0 GiB** |
| Langfuse (web about 880, worker about 770, ClickHouse about 700, MinIO, Postgres, Redis about 185 MiB) | about 2.5 GiB |
| **Everything together** | **about 5.4 GiB (47% of the limit)** |

This is lower than the rough estimate of section 2.2; these are idle figures and are higher under load (especially ClickHouse and Langfuse). Langfuse's own documentation recommends a "4 cores 16 GiB" virtual machine for itself, which is meant for production; for a local demo it runs together with the other services within 11.7 GiB of Docker memory, leaving no more room for anything else. The lite profile does not include Langfuse, so this figure does not affect it.

### 11.2 A difference from section 5: the format of the seed dump

The ready-made dump is not an SQL file but `seed/ai-seed.jsonl.gz` (gzip-compressed JSON lines: one header line, then one record per line). The reasons: it does not depend on `pg_dump`/`psql` being on the host and can be read and written with `uv run`; the columns are fetched from `information_schema` at run time, so columns added by later migrations need no script change; generated columns (the full-text index vector) are not written and are recomputed by the database. Content: 28 documents, 39 chunks, 39 vectors (`text-embedding-3-small`), 0 derived items, about 270 KB, kept directly in the repository. It **does not include** conversations, audit or evaluation records. `make seed` = import the business tables + restore the dump (one transaction, clearing existing documents first) + put the sample original files in the object store (so that clicking a citation can open the original); `make seed ARGS=--ingest` goes through the real ingestion pipeline.

### 11.3 Differences from section 6

- The tracing back end is **Tempo**, metrics are **Prometheus** (the Collector exposes OTLP metrics for it to scrape) and dashboards are **Grafana** (4: run overview, End states, search and model latency, ingestion). **Loki was not built**: logs are still JSON with `request_id`, `run_id` and `trace_id`, read with `docker logs`, saving about 0.5 GB.
- Cross-service traces: when the API calls MCP it connects the trace through the W3C `traceparent` header (a data question appears in Tempo as one trace across two services, the api and the mcp-server).
- **What goes into a span was decided**: run id, conversation id, model name, token counts, status, duration; **not** tokens, the original question or the original answer (setting `STARIT_OTEL_CAPTURE_CONTENT=true` adds the first 2000 characters of the input and output of each model call for Langfuse to show, off by default). A test asserts that tokens and the question text appear in no span, event or metric attribute. A database span carries the statement text and no parameter values (tested).
- Langfuse receives over OTLP/HTTP (it does not support gRPC); the Collector uses the `basicauth` extension to encode the authentication header on the spot from the project's public and private keys, so the repository holds no encoded credentials (gitleaks stopped the base64 I had first computed in advance at commit time, so it was changed to this approach). The Langfuse project, user and keys are created by `LANGFUSE_INIT_*` on first start, and the credentials are fixed local-only values that must be changed before exposing it. In Langfuse 4's "events_only" mode the old `/api/public/traces` is not available, and the Observations API v2 is used to read data.
- Versions (all checked to exist as images): OTel Collector contrib 0.164.0, Tempo 3.1.1, Prometheus v3.15.1, Grafana 13.3.0, Langfuse 4, ClickHouse 26.3.62.3, LiteLLM v1.106.6.
- A known trap: `opentelemetry-instrumentation-sqlalchemy` declares support only for SQLAlchemy < 2.1, while this project uses 2.1.6, so it refuses to start (one ERROR in the log, **and no database spans**); its `skip_dep_check` works around it, and a test proves that statements are recorded.
