# Implementation plan: phase 1 of the AI module

[中文](07-implementation-plan.chn.md)

Status: **Approved by the user (2026-11-02); all 5 confirmation points of section 7 were accepted, starting from M0.** Before each milestone starts, a checklist is listed first, and code is written after you confirm.
Basis: design documents 01 to 06 (all approved). Marking convention: **[Proposed]**, **[Open]**.

## 1. Way of working [Proposed]

- 9 milestones (M0 to M8). Each milestone can be **verified on its own**, and a report follows its completion: what was done, how it was verified, and what was not done or not verified. **The next one starts only after you confirm.**
- Before each milestone starts, I list the files to be created and changed and the commands to be run, and write code only after you say "start" (your requirement of "confirm before generating code").
- One branch per milestone (such as `m0-scaffold`), merged back into `main` when done and tagged (such as `ai-m0`); commits are small and the messages say why. **Whether to push to GitHub is asked every time.**
- When design and implementation differ, **change the design document first, then the code**, and make a note in the requirements document.
- What I need from you is listed at the start of the matching milestone and is never asked for midway.

## 2. Current environment check (verified)

| Item | Result |
|---|---|
| uv | 0.12.5 (Homebrew, arm64) |
| Python 3.12 | 3.12.12 available (system default 3.13.4; the project pins 3.12 with `.python-version`) |
| Node / pnpm | v20.19.6 / 10.33.2 (meets Next.js 15) |
| Docker / Compose | 29.8.1 / v5.5.1; Docker Desktop has about 11.7 GB of memory available |
| make / git | GNU Make 3.81 (bundled with macOS, an old version, so the Makefile uses only basic features) / git 2.50.1 |

## 3. Milestones

### M0 Scaffold and infrastructure

**Content**: uv workspace (`core`, `api`, `worker`, `mcp-server`); `.python-version`; Ruff, pytest, pre-commit (with secret scanning); a minimal GitHub Actions CI; `deploy/compose/` (Postgres+pgvector, Redis, MinIO, with health checks); Alembic initialisation; `core`'s configuration loading; the api's `/healthz`; `.env.example`; Makefile.
**What you need to provide**: nothing.
**Verification**: after `make up` every service is healthy; `pytest` passes; CI is green on GitHub.

### M1 Identity

**Content**: Keycloak added to Compose; the realm export file (7 roles, test accounts, the client and the audiences `starit-api` / `starit-mcp`); JWT verification in `core` (JWKS cache); the api's `/me`; a helper to get tokens for tests.
**Verification**: every test account can get a token; an invalid or expired token returns 401; `/me` returns the right role and campus.

### M2 Data model and permission core

**Content**: all `ai.*` migrations (02); the access-level expansion table; **the one shared permission filter function**; the service function that updates document permissions and chunks together (same transaction); `biz` seed import, the allow-listed views, the `ai_sql_ro` account and session-variable row filtering; audit log writing (append-only rights).
**Verification**: unit tests of the permission matrix (every role × every access level × campus × grade); the `Admin` role cannot read restricted content; the row rules of the views pass according to the table in section 5 of 02; migrations run from scratch on an empty database.

### M3 Ingestion pipeline

**Content**: the `Parser` interface and the docx / pdf / md / txt parsers; cleaning; structured chunking (tables and code blocks not split); code extraction; the embedding client (by configuration); the worker's job claiming and retries; the write transaction; the sample data import script (reading `manifest.csv`).
**What you need to provide**: **an OpenAI API key** (put in `.env`, never committed).
**Verification**: all 28 sample documents are ingested, and the number matches the manifest; the chunks' `allowed_roles` match the expansion table; uploading the same document again is idempotent; a deliberately broken file should end the job with a clear failing stage and reason; before ingestion an estimate of the number of embedding calls is given, and the run starts after you confirm (a very small amount).

### M4 Search and the first evaluation slice

**Content**: keyword search (the `ts_rank_cd` implementation of `KeywordSearcher`), vector search, RRF, `Reranker` (the LLM listwise implementation), context assembly, the `retrieval_mode` switch; the **search part** of the evaluation runner (`recall@k`, MRR, **permission regression**).
**Verification**: **zero leaks in the permission regression**; all four search modes run and produce a comparison; the evaluation set gives a search baseline, recorded in a report.

### M5 Agent graph and the chat API

**Content**: the LLM client interface (two implementations: the proxy for full and in-process for lite); the LangGraph graph (04); `finish_run`; the conversation and message endpoints (03); prompt files and versions; a fake LLM and search stubs.
**Verification**: graph structure tests (every node reaches some End); scenario tests for every End state; `clarification_limit` after two clarifications; timeout, retry limit and step limit; ask a few questions by hand with a real LLM, giving an estimate of the number of calls first.

### M6 Data access: MCP and the SQL agent

**Content**: the MCP server with 6 tools (03); the SQL agent subgraph (syntax and allow-list checks, timeout, row limit, retries); the `plan_data_access` node connected to the graph.
**Verification**: the 16 SQL evaluation questions; overreaching access is refused; tools accept no identity parameter; every call has an audit record.

### M7 Document management and front end

**Content**: the document management API (section 5 of 03); Next.js: OIDC sign-in, chat page, conversation list, citation display (click to view the original), document management page (upload, metadata editing, status and failure reasons, re-ingest, delete); the front end decides menu display from `/me` only, and the back end always checks.
**Verification**: each role sees the right menus after signing in; `RAGETLAdmin` completes the whole flow from upload to searchable; an ordinary user requesting the management endpoints directly gets 403; Playwright smoke tests cover sign-in, asking, viewing a citation and uploading.

### M8 Full evaluation, observability and wrap-up

**Content**: the full evaluation runner (answer correctness, refusal correctness, SQL, the experiment matrix, reports); additional evaluation questions (synthetic); OpenTelemetry through all services; Prometheus and Grafana dashboards; Langfuse (an optional Compose file); the ready-made vector store dump and the fast path of `make seed`; README and usage document updates; acceptance item by item against section 8 of design document 06.
**Verification**: acceptance criteria 1 to 7 pass one by one, with the results written to a report; tag `v0.1.0` (phase 1 of the AI module).

## 4. Dependencies and order

```
M0 → M1 → M2 → M3 → M4 → M5 → M6 ─┐
                          └──────→ M7 → M8
```

- M0 to M2 **need no LLM key**, so the security foundation can be laid first.
- Evaluation starts at M4 (the search part) and does not wait until the end, so every change has data behind it.
- The front end of M7 waits until the chat API of M5 is stable, but the document management API can be done after M3.
- All milestones go one person, in order, with no parallel development of the same set of files.

## 5. Risks and responses

| Risk | Response |
|---|---|
| Vector filtering and exact-scan performance | No problem at sample scale; when the scale grows, evaluate HNSW's iterative scan as in 2.4 of 02 |
| Latency and cost of the LLM rerank | Latency is recorded in evaluation; switch to a dedicated rerank interface if it exceeds expectations |
| Full-text tokenisation of codes | The `identifiers` column as the fallback; the evaluation has code-type questions |
| Too few evaluation questions | Add in M8; no conclusion about accuracy before then |
| Cost of real LLM calls | Every evaluation estimates first and confirms; unit and graph tests use a fake LLM; lite gets a daily budget cap |
| Keycloak's memory on the Mac | M1 records the actual use and fills it back into 06 |
| Python and Node version differences | Pinned with `.python-version` and `.nvmrc`; CI uses the same versions |
| Design and implementation drifting apart | Change the design document first, then the code |

## 6. Out of scope for phase 1

Streaming output, write action confirmation, memory, cost statistics (phase 2); the identity plan and deployment of lite (scheduled separately); the BM25 extension (decided after evaluation); the traditional business module (after the AI part is done); franchised campuses and Chinese-language data.

## 7. Points for you to confirm

1. The split and order of M0 to M8: accepted?
2. The way of "list the files and commands before each milestone and write code when you say start": accepted?
3. One branch per milestone, a tag after merging, pushing asked every time: accepted?
4. The OpenAI key is only needed from M3: is that all right?
5. Start from M0?

## 7. Phase 2 (2026-11-04)

The decisions of phase 2, and the scheduled and candidate items, are in [09 phase 2 plan](09-phase2-plan.md); the checklist of M9 is in [08](08-milestone-checklists.md). "Out of scope for phase 1" in section 6 is still the boundary of phase 1 and has not changed.
