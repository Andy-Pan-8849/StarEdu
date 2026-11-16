# Phase 1 acceptance (AI module v0.1.0, 2026-11-04)

[中文](acceptance-v0.1.0.chn.md)

The 7 criteria of [section 8 of design 06](../design/06-deployment-profiles-and-engineering.md) are recorded one by one: what was done, the result, and **what was not verified**. Acceptance was done on the author's own Mac (16 GB, Docker Desktop memory limit about 11.7 GiB, disk 80 GB), **not on a clean machine**; the real models are `gpt-6-luna` (chat) and `text-embedding-3-small` (embedding).

## 1. `make up && make seed` runs through from scratch

- **How**: `make clean` (deletes all of this project's local data volumes: all the data of Postgres, Redis, Keycloak, the object store, Tempo, Prometheus, Grafana and Langfuse; `.env` is kept), then `make up-langfuse` (core services + observability + Langfuse), then `make seed`.
- **Result**: cleaning took 19 seconds; `make up-langfuse` about 2 minutes 30 seconds (the 19 long-running containers were all running, those with health checks were healthy, the migration container ran first and exited, Keycloak imported the demo realm, and Langfuse created the project from `LANGFUSE_INIT_*`); `make seed` 4 seconds: the business tables (campuses 8, employees 141, students 60, assignments 12, submissions 198, expense claims 108, tickets 70), the knowledge base restored from the dump (28 documents, 39 chunks, 39 vectors), the 28 original files put in the object store; all 28 documents were `ready`. From the start of cleaning to being able to ask took about 3 minutes.
- **Afterwards**: asking with a demo account got an answer with citations, and the cited original could be opened (HTTP 200); the browser smoke test passed 3/3.
- **Not verified**: (a) **this is not a truly new machine**: the images and the uv cache are on this machine, and a truly new machine first has to pull images and build (once an API image build on this machine took about 40 minutes, mainly because the network was slow downloading Python dependencies; the Dockerfile now makes the dependencies a separate layer and uses a uv cache mount, so changing code no longer downloads them again); (b) "only the LLM key needs filling in": `make seed` itself needs no key, asking needs `OPENAI_API_KEY`, and I did not verify `make env` from scratch in a directory with no `.env`; (c) not tried on Linux or Windows.

## 2. Asking as each role gets an answer with citations or a clear refusal, and every run has an End state

- **How**: the full evaluation `starit-eval all`, with 114 document questions asked by the demo accounts of 7 roles (student, staff, manager, hr, finance, Admin, RAGETLAdmin), plus 41 data questions.
- **Result**: **End state valid 114/114** (every run has an `end_state`, and the `end_reason` matches the state); answers passed 99/114 and data questions 41/41. The 15 questions not passed were read one by one, none was a permission leak, and the classification is in the [evaluation record](README.md).
- **Not verified**: of the answer correctness, 48 questions were judged by the model judge, and **the 20% human spot check had not been done**; `understand` asked too many clarifying questions on 4 of 87 questions that could be answered directly, known and not fixed.

## 3. `RAGETLAdmin` can upload, change permissions, delete and re-ingest on the document management page, and see the ingestion status and failure reasons

- **How**: 82 back-end document API tests (7 roles × 7 management endpoints, upload validation, the whole flow, changing permissions, deleting, re-ingesting, list filters); front-end Vitest (editing, jobs and error reasons, delete confirmation and so on); Playwright against the real Compose stack: `RAGETLAdmin` signs in → uploads → waits for `ready` → deletes (with confirmation), an ordinary user does not see the menu and gets 403 on a direct request; in the real check one small document was uploaded and ingested with real embedding.
- **Result**: all pass (the browser tests were also rerun on the stack started again from empty, 3/3).
- **Not verified**: **editing permissions, re-ingesting and viewing failure reasons were not clicked in a real browser**; they are covered by the API tests and Vitest, and Playwright covers only uploading, reading a citation and deleting.

## 4. Permission regression fully passes, and the `Admin` account cannot read restricted document content

- **How**: 114 questions × 7 roles × 3 search modes that use no model = 2,394 searches, every returned chunk checked with independent rules (written from the permission table of the README, not using the code under test); the per-question check of all four modes (including rerank); the per-account comparison at the view layer; the 404 rule of the API layer.
- **Result**: **0 overreaching chunks** (the full evaluation report, the same check in `make test`, CI). Questions from `Admin` and `RAGETLAdmin` were refused (one each in the evaluation, passed); `RAGETLAdmin` reading a document body gets 404 and reading metadata gets 200 (API tests and browser tests).
- **Not verified**: the permission checks are rules I wrote against an implementation I wrote, and both sides could make the same mistake; there is no third-party audit. Campus scope has no separate test matrix for **documents** (the campus scope of all sample documents is `all`).

## 5. The evaluation command runs and produces a report, including a comparison of search modes

- **Result**: `starit-eval all`, `answers`, `matrix`, `retrieval`, `agent` and `data` all run; the full report has the comparison of the four search modes (hit@1 0.862 / 0.885 / 0.943 / 1.0, MRR 0.916 / 0.940 / 0.971 / 1.0), and the matrix has the comparisons of chunk size, the `identifiers` boost and derived content; results are written to `ai.eval_runs`.
- **Not verified**: the sample is small (114 questions, 7 to 35 per type), **so no conclusion about accuracy is drawn**; the item-by-item comparison with the conclusions of the earlier RAGFlow trial was not done (this milestone did not run RAGFlow again).

## 6. Langfuse and Grafana can show the trace and metrics of the same run

- **How**: on the stack started again from empty, ask one real question, find the trace in Tempo by TraceQL with the run id (the span attribute `run_id`), then fetch the observations with the same trace id from Langfuse's Observations API v2.
- **Result**: the same trace is in both places: in Tempo it is the api's request, every step of the graph, every model call and every database statement; in Langfuse it is 33 observations, of which 3 are `GENERATION` (with the model name `openai/gpt-6-luna` and token counts), and the session id equals the conversation id. The trace of a data question spans two services, the api and the mcp-server (measured). Prometheus has `starit_runs_total`, `starit_llm_*`, `starit_retrieval_*`, `starit_tool_calls_total` and the HTTP metrics; all 4 Grafana dashboards are loaded and every query can run (only the panel "ingestion jobs" is empty when nothing has been ingested, and has data after the upload in the browser test was run).
- **Not verified**: the Grafana dashboards **were not looked at by a human eye for how they render** (only that the dashboards exist, the query syntax is correct and there is data); the evaluation scores in Langfuse were not written (only traces were connected, and the evaluation results were not pushed there); Loki (logs) was not done.

## 7. Unit and graph structure tests pass in CI

- **Result**: on this machine 793 Python tests (including integration tests that need the database), 61 front-end tests and 3 browser tests all pass; ruff, mypy (strict), front-end lint, type check, format check and production build are all clean. The two GitHub CI jobs `ai-module` and `web` succeeded on the `m8-eval-observability` branch (the last push took 4 minutes 08 seconds). CI does not run the real-model evaluation and does not run Playwright (there is no full Compose stack).
- **Not verified**: CI runs the Python part on Linux, and it has not been run on Windows.

See also: the [architecture diagram review table](architecture-review.html) (a web page, filterable), which compares every AI-related cell of the reference architecture diagram, the requirements list A to H and the phase 2 (P1) items one by one.

## Known limits (not solved, and not pretended to be solved)

- The token is kept in the browser's `sessionStorage`; `npm audit` has a few notices about development tools and the PostCSS bundled with Next.js (they only concern untrusted CSS input, which this project does not process), and no upgrade was forced.
- The campus check for SQL that "points indirectly to another campus by a city name" is best effort only (the real protection is the database view, and what slips past gives empty data, not another campus's data).
- The over-asking of clarifying questions by `understand`, and the generate step occasionally still marking `sufficient` when there is no answer.
- The credentials of Langfuse and Grafana and the master key of LiteLLM are fixed local-only values and **must be changed before exposing them**.
- The lite profile (Oracle k3s) and its identity plan are scheduled separately and are outside the scope of phase 1.
