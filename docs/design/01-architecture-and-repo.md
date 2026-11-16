# Design document 01: overall architecture and code structure (AI module, phase 1)

[中文](01-architecture-and-repo.chn.md)

Status: **Items 1 to 4 of section 7 were confirmed by the user (2026-11-02); item 5 was revised in the ninth round of discussion. This document is treated as approved.** No application code is written before the other design documents are approved.
Scope: phase 1 of the AI module (the feature list is in round 7 of `docs/project-requirements.md`). The traditional business module is out of scope here.

Marking convention: **[Decided]** the user has decided; **[Proposed]** my proposal, awaiting approval; **[Open]** needs measuring or separate discussion.

## 1. Technology choices already made

| Item | Choice | Status |
|---|---|---|
| Python | 3.12, uv for packages (workspace) | [Decided] |
| AI back end | FastAPI | [Decided] |
| Agent orchestration | LangGraph | [Decided] |
| Tool protocol | MCP server (separate process) | [Decided] |
| Database | PostgreSQL + pgvector; full-text search uses Postgres's own | [Decided] |
| Front end | Next.js 15, Tailwind, shadcn/ui | [Decided] |
| Identity | Keycloak (full), standard OIDC / JWKS to verify the JWT | [Decided] |
| LLM | OpenAI, Anthropic, through LiteLLM | [Decided] |
| Embedding | `text-embedding-3-small`; provider, model and dimensions are configuration variables | [Decided] |
| Tracing | Langfuse (local only), OpenTelemetry | [Decided] |

## 2. Components and responsibilities

```
Browser ── Next.js (web) ──HTTP/SSE──▶ FastAPI (api) ──▶ LangGraph flow
                                          │                │
                                          │                ├─▶ search service (core): permission filter → full text + vector → RRF → rerank
                                          │                ├─▶ MCP server: document search, read-only courses/students, expense status
                                          │                └─▶ LLM client ─▶ LiteLLM ─▶ OpenAI / Anthropic
                                          ▼
                                    PostgreSQL + pgvector
                                          ▲
Upload ─▶ api ─▶ object store + ingestion_jobs ─▶ worker (parse → chunk → derive → embed → write)

The JWT is issued by Keycloak; the api and the MCP server both verify it with JWKS.
The trace of every run goes to Langfuse / OTel.
```

| Component | Responsibility | Notes |
|---|---|---|
| web | Chat page, conversation list, citation display, document management page | The document page is visible to `RAGETLAdmin` only |
| api | Authentication, conversations, chat (SSE), document management endpoints, evaluation trigger | Stateless, can have several replicas |
| worker | Takes ingestion jobs and runs the ETL | Shares `core` with the api, separate process |
| mcp-server | Exposes tools over MCP and checks the same JWT | Separate process, **[Proposed]** port 8100 |
| core | Shared library: configuration, database, permissions, search, LLM client, models | Not deployed on its own |
| Postgres | Business metadata, chunks, vectors, conversations, audit | One instance, separated by schema |
| Object store | The original documents | full: MinIO-compatible (pgsty/silo, see 4.7); lite: [Open] |
| Redis | Cache, rate limiting | **Does not carry the job queue**, see 4.1 |

## 3. Code structure [Proposed]

Keep using the existing `ai-module/`, with the Python part as a uv workspace:

```
ai-module/
├── pyproject.toml            uv workspace root
├── .python-version           3.12
├── packages/
│   └── core/                 shared library (src/starit_core)
├── apps/
│   ├── api/                  FastAPI
│   ├── worker/               ETL worker
│   └── mcp-server/           MCP server
├── web/                      Next.js
├── migrations/               Alembic (the AI side's own schema)
├── eval/                     evaluation runner and reports (the evaluation data stays in sample-data/eval)
├── deploy/
│   ├── compose/              compose files for full / lite, .env.example
│   └── k3s/                  Helm values (later)
└── sample-data/              already exists
```

Points:
- The business module will be self-contained in `business-module/` later and shares no code with the AI module; the two interact only over HTTP / JWT and different schemas of the same Postgres instance.
- `core` does not depend on FastAPI, so the worker, the MCP server and the evaluation runner can all reuse it directly.
- Each app has its own Dockerfile and they share one lock file.

## 4. Key design decisions

### 4.1 Ingestion job queue: a Postgres table with `FOR UPDATE SKIP LOCKED` [Proposed]

- Reason: neither full nor lite needs a new component; the job and the document status are updated in one transaction, and retries and visibility ("ingestion status, failure reason") are a plain table query.
- Cost: lower throughput than Kafka / Redis Streams, but enough for the sample scale (tens to hundreds of documents).
- Interface isolation: the worker depends only on a `JobQueue` interface, so switching to Redis Streams later does not touch the business code.

### 4.2 LLM access: one interface, two implementations [Proposed]

- Code depends only on the `LLMClient` interface in `core` (chat, streaming, embedding).
- full: through the LiteLLM proxy service; lite: to save memory, the litellm library is used inside the process. The configuration variable names are the same for both.

### 4.3 Authentication and roles [Decided, round 9]

- Business scope: **company-run campuses only**. All 8 campuses in the sample are treated as run by the headquarters; franchised campuses (independently managed multi-tenancy) are out of scope, and the permission structure keeps a `campus_id` attribute so it can be extended later.
- Keycloak realm roles, 7 in all:
  - Business roles: `student`, `staff`, `manager`, `hr`, `finance`, matching the access model of the evaluation set one to one.
  - Administrative roles: `Admin`, `RAGETLAdmin`.
- **No `SchoolAdmin`**: a campus manager is expressed as the `manager` role plus a `campus_id` attribute (the Campus Director of the sample, level M3).
- Attributes (JWT claims): user id, roles, `campus_id`, `level` (from `employees.csv`), `employee_id` or `student_id` (for "own records only"); department and other fields are reserved.
- Data scope: policy documents are controlled by role; structured data and campus materials are controlled by data scope (whole company / own campus / own records only); `hr` and `finance` have whole-company scope. See 02.
- `Admin`: manages users, assigns roles, system configuration. **Does not read restricted document content by default** (least privilege); reading content also requires the matching business role.
- `RAGETLAdmin`: uploads, deletes and re-ingests documents, views ingestion status; reading document content still follows their business role.
- The api and the MCP server each verify the JWT and trust no identity field sent by the front end.
- Test accounts are named `<given name>.<function>.<campus>`, and each one is a real person in the sample data (see `ai-module/sample-data/demo-accounts.csv`): `wei.stu.sh`, `ning.adm.bj`, `wei.acad.sh`, `ling.mgr.bj`, `peng.mgr.sh`, `qing.hr.bj`, `ning.fin.bj`, `tao.admin.bj`, `min.ragetl.bj`, used to test "same role, different campus". The old account names from M1 were replaced in M2. Phase 2 may add an `Auditor` (read-only audit log).

### 4.4 Flow control: a LangGraph state graph [Proposed]

- The outer graph is fixed and search is a fixed node; the LLM only does intent understanding, query rewriting and generation.
- Every run ends at an explicit End node with a reason code. The nodes and reason codes are listed in design document 04.
- The conversation state (`answering` / `need_clarification`) is an explicit field of the graph state, not an implicit variable.

### 4.5 Configuration [Proposed]

- Environment variables are the only source; Compose uses `.env` (with an `.env.example`; the real `.env` stays out of Git).
- Variable names have the prefix `STARIT_`, grouped by component; embedding ones are `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`.
- Entry address priority follows the rule already decided: domain name → public IP → localhost + port.

### 4.6 Port plan [Proposed]

| Service | Port |
|---|---|
| web (AI) | 3000 |
| business web / NestJS (later) | 3001 / 4000 |
| api | 8000 |
| mcp-server | 8100 |
| Keycloak | 8080 |
| LiteLLM | 4100 (avoids NestJS's 4000) |
| Langfuse web | 3100 (avoids 3000) |
| Postgres | 5432 |
| Redis | 6379 |
| MinIO | 9000 / 9001 |

**Each component uses its common default port, for the convenience of learners**; the host port is also an environment variable, so if a local port is taken only `.env` changes, and containers talk to each other by service name, unaffected.

### 4.7 Object store [M0 revision, 2026-11-02]

- Verified: the official MinIO Docker images (`minio/minio`, `quay.io/minio/minio`) can no longer be pulled from the official registries.
- Decision: the S3-compatible store of the full profile uses MinIO's community fork **`pgsty/silo`** (pinned version tag, amd64 and arm64 both available, already run on this machine during the RAGFlow trial); ports and environment variables are the same as MinIO's (9000 / 9001).
- **Code depends only on the S3 API**, so switching to another S3-compatible implementation later (such as SeaweedFS or a cloud vendor's object store) only changes configuration. The object store of the lite profile is still [Open].

### 4.8 Identity implementation (what M1 actually did, 2026-11-02)

- Keycloak `26.8.1`, `start-dev` with the built-in file database (container volume); the realm file `deploy/compose/keycloak/starit-realm.json` is imported on first start. For the local full profile only; the identity plan for lite is still [Open].
- The token issuer is fixed at `http://localhost:8080/realms/starit` (`KC_HOSTNAME`). The back end uses two settings: `STARIT_OIDC_ISSUER` (to verify the issuer) and `STARIT_OIDC_JWKS_URL` (to fetch the public keys, over the Compose network inside containers).
- The token carries `realm_access.roles`, `campus_id` and `level`, and its audience contains both `starit-api` and `starit-mcp`. `campus_id` and `level` are **explicitly declared** in the realm's user attributes (declarative user profile); "unmanaged attributes" are not enabled.
- The back end accepts only RS256 / ES256, checks signature, expiry, issuer and audience, requires `sub`; it rejects `alg: none` and HS256 (against algorithm confusion); it recognises only the 7 known roles and ignores the rest (Keycloak's default roles).
- If the public keys cannot be fetched (identity service unavailable) it returns 503, not 401.
- The common error format (section 1 of 03) is in place: 401 / 403 / 404 / 422 all carry a `request_id`.
- The `starit-web` client has the password grant enabled only so local scripts and tests can get tokens; a real deployment must turn it off.

## 5. Differences between the two profiles (AI module)

| Item | full (local Compose) | lite (Oracle k3s) |
|---|---|---|
| Identity service | Keycloak | [Open] (decided after measuring memory) |
| LLM access | LiteLLM proxy | litellm in the process |
| Tracing | Langfuse + OTel | OTel only, Langfuse not deployed |
| Observability | Prometheus, Grafana, Loki, Tempo | Reduced, details in later documents |
| Object store | MinIO | [Open] |
| Rerank | Same implementation, model chosen by configuration | Same; prefer a small model or an API call |

## 6. Questions for the next documents to answer

- 02 data model: table structure, permission metadata fields, indexes (full text + vector), conversation and audit tables.
- 03 API and MCP contract.
- 04 agent flow chart, End states and reason codes.
- 05 search and permissions: filtering, RRF, rerank, evaluation plan.
- 06 deployment details and memory budget of the two profiles (needs measuring).

## 7. Confirmation results (2026-11-02)

1. Ingestion queue as a Postgres table: **accepted**.
2. litellm in the process for lite, the proxy for full: **accepted**.
3. Directory structure (including `web/` under `ai-module/`): **accepted**.
4. Port plan: **accepted**.
5. Roles: revised in the ninth round of discussion, see 4.3.

## 11. M8 revision record (2026-11-04)

- **The LiteLLM proxy was only added in M8**: section 4.2 (confirmed) says the full profile calls models through the LiteLLM proxy service. From M5 on, what actually ran was the in-process litellm library, and Compose had no such service; this is a deviation M5 failed to record. M8 adds it: Compose gains a `litellm` service (image `ghcr.io/berriai/litellm:v1.106.6`, the same as the pinned library version; host port 4100; configuration `deploy/litellm/config.yaml`, one wildcard per vendor, `openai/*` and `anthropic/*`, so changing a model only changes settings). With `STARIT_LLM_GATEWAY=litellm_proxy` (set for api, worker and mcp-server in Compose) every chat and embedding request goes to it; running directly on the host (`uv run`, evaluation) still defaults to `litellm_lib`. **The vendor keys are only in the `litellm` container**; the environment of the other three services has none (tested and measured). Services authenticate to each other with `LITELLM_MASTER_KEY` (a local default; change it before exposing it).
- **Ports**, added: Grafana 3300 (avoids web's 3000), Prometheus 9090, Tempo 3200, OTLP/HTTP 4318, Langfuse 3100 (consistent with the plan above); all host ports are environment variables.
- **Scope of observability**: the api, worker and mcp-server are wired to OpenTelemetry; in Compose it is the optional `observability.yaml` (OTel Collector, Tempo, Prometheus, Grafana) and `langfuse.yaml`, and the core services do not depend on them.
