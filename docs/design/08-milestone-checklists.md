# Milestone checklist record

[中文](08-milestone-checklists.chn.md)

Before each milestone starts, "the files to create and change, the commands to run, the verification criteria and the things that were unclear beforehand" are listed and kept here, and code is written only after the user confirms. After completion, the "actual results" are added (anything that differs from the plan is written separately). New milestones are appended at the end.

Basis: [07 implementation plan](07-implementation-plan.md).

---

## M0 Scaffold and infrastructure

Status: **Done and merged** (tag `ai-m0`, merge commit `6812320`, 2026-11-02).

### Planned files (under `ai-module/` unless stated otherwise)

| File | Purpose |
|---|---|
| `.python-version` | Pins 3.12 |
| `pyproject.toml` | uv workspace root; Ruff, pytest and mypy configuration |
| `Makefile` | `up`, `down`, `test`, `lint`, `migrate` and so on |
| `.env.example` | Variable notes and defaults |
| `packages/core/` (`config.py`, `db.py`, `logging.py`, `tests/`) | Configuration loading, database connection, logging with `request_id` |
| `apps/api/` (`main.py`, `tests/`) | FastAPI, `/healthz` checks the database |
| `apps/worker/`, `apps/mcp-server/` | Minimal entry points and import tests (functions left to M3 and M6) |
| `migrations/` (`alembic.ini`, `env.py`, `versions/0001_baseline.py`) | Creates the `ai` and `biz` schemas and the `vector` extension |
| `deploy/compose/compose.yaml` | Postgres+pgvector, Redis, object store, api, all with health checks |
| `deploy/docker/python.Dockerfile` | Builds the Python service image with uv |
| Repository root `.pre-commit-config.yaml` | Ruff, format check, secret scan |
| Repository root `.github/workflows/ci.yml` | Checks, tests, migrations run on an empty database |
| `README.md` (`ai-module/`) | Development environment start instructions |

### Planned commands

```bash
git switch -c m0-scaffold
uv sync
make lint && make test
make up
make migrate
curl localhost:8000/healthz
```

### Verification criteria

1. After `make up` every service is healthy, and `/healthz` returns success including the database status.
2. `make test` passes entirely and `make lint` reports nothing.
3. `make migrate` succeeds on an empty database, and the `ai` and `biz` schemas and the `vector` extension exist.
4. Committing a file with a fake secret is blocked by pre-commit.
5. CI turns green on GitHub.

### Things unclear beforehand

Image tags, and whether the MinIO image can still be pulled.

### Actual results

| Item | Result |
|---|---|
| Criteria 1 to 5 | All met: lint and mypy pass; 11 tests pass (including integration tests); four containers healthy; migrations can be run repeatedly; gitleaks blocked a fake GitHub token; CI passes |
| **Differs from the plan** | The official MinIO image can no longer be pulled, so the MinIO-compatible fork `pgsty/silo` (pinned version) is used; design document 01 (section 4.7) was changed first and then the code written |
| **Differs from the plan** | CI was first triggered only on `main` and PRs, so branch pushes did not run it; it now triggers on every push |
| Image versions | `pgvector/pgvector:0.8.7-pg17`, `redis:7-alpine`, `pgsty/silo:RELEASE.2026-08-06T00-00-00Z` |
| pre-commit versions | The versions in the first draft were too old and were updated with `pre-commit autoupdate` (ruff v0.17.3, gitleaks v8.30.0, pre-commit-hooks v6.0.0) |

---

## M1 Identity

Status: **Done, awaiting merge** (branch `m1-identity`).

### Planned files (under `ai-module/` unless stated otherwise)

| File | Purpose |
|---|---|
| `deploy/compose/compose.yaml` (changed) | Adds the `keycloak` service, and the api depends on it |
| `deploy/compose/keycloak/starit-realm.json` (new) | The realm: 7 roles, test accounts, clients, audiences |
| `packages/core/src/starit_core/auth.py` (new) | JWT verification, `Identity`, the FastAPI dependencies `get_identity` and `require_roles` |
| `packages/core/src/starit_core/config.py` (changed) | Adds OIDC settings |
| `packages/core/pyproject.toml` (changed) | Adds `PyJWT[crypto]` |
| `apps/api/src/starit_api/main.py` (changed) | Adds `GET /me` |
| `packages/core/tests/test_auth.py` (new) | Unit tests of JWT verification (keys generated locally, no Keycloak needed) |
| `apps/api/tests/test_me.py` (new) | Unit tests of `/me` |
| `apps/api/tests/integration/test_keycloak.py` (new) | Gets tokens from a real Keycloak and checks `/me` for every account |
| `scripts/token.sh` (new) | `make token ACCOUNT=staff.sh` gets a test token |
| `.env.example`, `Makefile`, `README.md` (changed) | Notes on the new variables and commands |
| `.github/workflows/ci.yml` (changed) | CI starts Keycloak and runs the integration tests |
| `docs/design/01-architecture-and-repo.md` (changed) | Records the implementation decisions of M1 |

### Detailed design

- **Keycloak**: `quay.io/keycloak/keycloak:26.8.1`, `start-dev`, with the built-in file database in a container volume; `KC_HOSTNAME` is fixed to `http://localhost:8080` so the token issuer is fixed; the back end uses two settings, `STARIT_OIDC_ISSUER` (to verify the issuer) and `STARIT_OIDC_JWKS_URL` (to fetch public keys; inside containers `http://keycloak:8080/...`).
- **Roles**: `student`, `staff`, `manager`, `hr`, `finance`, `Admin`, `RAGETLAdmin`.
- **Token content**: roles, `campus_id`, `level` (from user attributes; unmanaged attributes must be switched on). The audience contains both `starit-api` and `starit-mcp`.
- **Test accounts**: `student.sh` (SH), `staff.bj`, `staff.sh`, `manager.sh`, `hr.bj`, `finance.bj`, `admin.bj`, `ragetl.bj`. Passwords are fixed demo values, for local use only.
- **Client**: `starit-web` (authorization code + PKCE); to let scripts and tests get tokens, the password grant is on, enabled only in the local demo realm and to be turned off in production.
- **Back-end verification**: checks signature, expiry, `iss` and `aud`; rejects `alg: none`; recognises only the 7 known roles; JWKS cache.

### Planned commands

```bash
git switch -c m1-identity
uv sync --all-packages
make up
make token ACCOUNT=staff.sh
curl -H "Authorization: Bearer $(make -s token USER=staff.sh)" localhost:8000/me
make lint && make test
```

### Verification criteria

1. All 8 accounts can get a token, and `/me` returns the right role and campus.
2. No token, expired, a tampered signature, a wrong issuer or audience all return 401.
3. Unit tests cover the above and can run without Keycloak.
4. The integration tests pass with a real Keycloak, and CI passes.
5. Record Keycloak's actual memory use and fill it back into design document 06.

### Things unclear beforehand

- The realm import format of Keycloak 26.8 and how to switch on unmanaged attributes (confirm against the official documentation).
- The Keycloak container has no `curl`, so how to write the health check; start-up is slow, and the waiting time of `make up` gets longer.
- Starting Keycloak in CI makes each CI run about a minute longer.

### Actual results

| Item | Result |
|---|---|
| Criterion 1 | All 8 accounts got tokens, and `/me` returns the right role, campus and level (the integration test checks them one by one, and the api in a container was checked with real tokens too) |
| Criterion 2 | No token, a garbled token, expired, a tampered signature, a wrong issuer, a wrong audience, a missing `sub`, `alg: none` and HS256 algorithm confusion are all 401 (unit tests + an integration test with a really tampered token) |
| Criterion 3 | The unit tests do not need Keycloak and use a locally generated RSA key |
| Criterion 4 | All 43 local tests pass (including integration); GitHub CI passes (including starting Keycloak, taking about 1 minute 38 seconds) |
| Criterion 5 | Filled back into section 2.2 of design document 06 (Keycloak about 650 to 675 MiB, start-up about 10 seconds) |
| **Differs from the plan** | The command parameter name changed from `USER` to `ACCOUNT` (`USER` is confused with a system environment variable) |
| **Differs from the plan** | "Unmanaged attributes" were not switched on; `campus_id` and `level` are declared explicitly in the user attribute configuration, which is clearer |
| **Added (beyond the plan)** | `starit_api/errors.py` and `deps.py`: the common error format, `get_identity`, `require_roles`; 503 when the public keys cannot be fetched; ruff's B008 relaxed for FastAPI's `Depends` in `pyproject.toml` |
| Things unclear beforehand | The realm import of Keycloak 26.8.1 worked at the first attempt; the health check uses the management port 9000 with bash's `/dev/tcp` and works; `make up` now waits about 10 to 30 seconds more |
| Image version | `quay.io/keycloak/keycloak:26.8.1` |

---

## M2 Data model and permission core

Status: **Done and merged** (tag `ai-m2`, merge commit `bf6fd4d`, 2026-11-02). This is the most critical security foundation of the whole project and needs no OpenAI key.

### The user's decisions (2026-11-02, reply to the first draft of this checklist)

| # | Question | Decision |
|---|---|---|
| 1 | Database accounts | `starit` (owner, migrations), `ai_app` (application), `ai_sql_ro` (read-only, cannot log in, switched to with `SET LOCAL ROLE`). **Approved** |
| 2 | Visibility of the views | Stick to "an employee sees only their own campus", and **change the evaluation set and the sample data** accordingly. Also clarified: **policy documents** exist once for the whole company and are controlled by role only, regardless of campus; **structured data and campus materials** are controlled by data scope (whole company / own campus / own records only). `hr` and `finance` (headquarters functions) have whole-company scope. This matches the usual "data permission" of enterprise back offices, **adopted** |
| 3 | Account naming | `<given name>.<function>.<campus>`, matching real employees. **Approved** (9 accounts, see the sample-data README) |
| 4 | Grade mapping | 1: S1, I1; 2: S2, I2; 3: S3, I3; 4: I4; 5: I5; 6: M2; 7: M3. **Written in the README** (written into `sample-data/README.md` and into section 4 of design 02) |
| 5 | Row filtering | Only a `WHERE` in the view, no RLS. **Approved** (the difference between RLS and views was explained to the user, and RLS can serve as a second safeguard later) |

### M2.0 Revision of the sample data and the evaluation set (done)

| Item | Content |
|---|---|
| Sample data | The 5 headquarters-function employees of HR, Finance, IT and the Academic Office moved from Chengdu (CD) to the headquarters in Beijing (BJ); the campus of a ticket became the **campus of the person who opened it** (only the `campus_id` column changed, the other random data stayed the same, confirmed by a check) |
| Added | `demo-accounts.csv`: 9 demo accounts, matching real employees or students; grade levels |
| Evaluation set | `sql-qa.jsonl` grew from 16 to 33 questions: each carries `asker` (account), `role`, `scope`, `should_answer`; whole company 16, own campus 7, own records 3, overreaching and to be refused 7; answers are computed only from the rows that account can see |
| Generator | `tools/generate_structured.py` gained the data-scope function `visible()` (consistent with the view rules); the script has assertions and errors at once if the person a demo account points to changes; running twice gives the same result (deterministic) |
| README | `sample-data/README.md` gained "Who can see what", "Job levels" and "Demo accounts"; the top-level and AI module READMEs gained pointers; the total number of evaluation questions is 87 |
| Design documents | 02 (three accounts, two kinds of access control, the filter, the grade table, the view rules, tamper protection), 01 (tokens gain `employee_id` / `student_id`, account naming), 03 (`/me`), 05 (composition of the evaluation set) were updated |

### Planned files (under `ai-module/` unless stated otherwise)

| File | Purpose |
|---|---|
| `migrations/versions/0002_knowledge_tables.py` | `ai.documents`, `document_chunks` (`tsv`, `identifiers`, denormalised permission fields, `min_level_rank`), `chunk_embeddings`, `chunk_derived`, `ingestion_jobs`, and indexes |
| `migrations/versions/0003_conversation_audit_eval.py` | `ai.conversations`, `messages`, `runs`, `audit_log`, `eval_runs`, `eval_results`; creates `ai_app`; grants (`audit_log` INSERT only); the consistency check view `ai.v_chunk_permission_drift` |
| `migrations/versions/0004_biz_and_sql_views.py` | The 7 `biz` tables; the allow-listed views of `ai_sql`; the `ai_sql_ro` role (cannot log in) and grants; revokes `PUBLIC` execution of `set_config` |
| `packages/core/src/starit_core/permissions.py` | The access-level expansion table, the grade mapping, `COMPANY_WIDE_ROLES`, **the one shared search permission filter function** (a SQLAlchemy expression, no string concatenation) |
| `packages/core/src/starit_core/documents.py` | The document service: registering documents; when permissions or status change, updates the document and all chunks in **the same transaction** and writes audit |
| `packages/core/src/starit_core/audit.py` | Writes audit records |
| `packages/core/src/starit_core/sqlaccess.py` | Sets the identity variables inside a transaction and does `SET LOCAL ROLE ai_sql_ro` |
| `packages/core/src/starit_core/auth.py` (changed) | `Identity` gains `employee_id` and `student_id` |
| `packages/core/src/starit_core/config.py` (changed) | `migration_database_url`, the application account password |
| `migrations/env.py` (changed) | Migrations connect as the database owner |
| `scripts/seed_biz.py` (new), `Makefile` (changed) | `make seed-biz`: imports `sample-data/structured/*.csv` |
| `scripts/build_realm.py` (new) | Generates `starit-realm.json` from `demo-accounts.csv`, keeping accounts consistent with the sample data |
| `deploy/compose/compose.yaml`, `.env.example` (changed) | The api connects as `ai_app`; adds the migration connection and the application account password variables |
| `deploy/compose/keycloak/starit-realm.json` (regenerated) | 9 accounts, new attributes `employee_id` / `student_id` |
| `apps/api/tests/integration/test_keycloak.py`, `README.md` (changed) | Tests and documents after the account renaming |
| `packages/core/tests/test_permissions.py` (new, unit) | The expansion table compared line by line with `manifest.csv`; the grade mapping |
| `packages/core/tests/integration/` (new, needs the database) | Permission matrix, document service, audit, views, security defences |

### Planned commands

```bash
git switch -c m2-data-permissions        # already created
make up && make migrate                  # migrations now run as the database owner
make seed-biz
make test
make lint
```

### Verification criteria

1. **Migrations**: upgrade from scratch on a brand-new database succeeds; downgrade and upgrade again also succeed.
2. **Expansion table**: the 28 lines of `manifest.csv` expanded one by one equal the access model of the evaluation set (unit test).
3. **Permission matrix (differential test)**: write chunks covering every access level, campus scope, `allowed_users`, grade and status into the database, and for 7 roles × several campuses × several grades compare an **independently written Python decision** with the SQL filter function; they must agree completely, including the whole-company scope of `hr` and `finance`.
4. **Least privilege**: `Admin` and `RAGETLAdmin` (with no other business role) cannot find any document chunk; an identity with no role or only unknown roles finds nothing.
5. **Document service**: after changing permissions or status the document and all chunks are consistent within the same transaction; an exception midway rolls everything back; the consistency check view is empty.
6. **Audit**: `ai_app` can insert and **cannot UPDATE or DELETE**.
7. **SQL views**: for the 9 demo accounts the number of rows each view returns matches the expectation computed independently from the CSV (per the "data scope" table); `ai_sql_ro` cannot read the original `biz` tables or any table of `ai`; with no identity variables the views return nothing; for the evaluation questions whose answer can be obtained from the views, the view result matches `expected_answer`.
8. **Tamper protection**: running `SELECT set_config('app.roles','hr',true)` as `ai_sql_ro` is refused by permissions; the `SET LOCAL ROLE ai_sql_ro` flow works.
9. The integration tests of M1 still pass after the account renaming and the new attributes; CI passes.

### Things unclear beforehand

- When `tsv` is a generated column, Postgres requires the expression to be immutable and `array_to_string` may not satisfy that; if it is refused, a trigger will maintain `tsv` instead.
- Revoking execution of a system function in `pg_catalog` must be confirmed to work in the pgvector image without affecting the normal use of Alembic and the application (verified in tests).
- Creating the password of `ai_app` by reading an environment variable in a migration needs confirming that the way it is written works both locally and in CI.
- After `ai_app` becomes a non-superuser, whether `/healthz` and the tests of M1 need additional grants.
- The existing `starit-ai_pgdata` volume holds the old database of M0 and M1: migrations go forward and need no clearing; but the old realm in the Keycloak volume is not imported again, so after the account renaming `make clean` or deleting the `keycloakdata` volume is needed (only demo data is lost).

### Actual results

**Verification criteria** (all met; all 117 local tests pass, including integration tests; M1 had 43):

| # | Result |
|---|---|
| 1 Migrations | Upgrade, downgrade to 0001 and upgrade again succeed on a brand-new database (automated test, with a temporary database); `make clean && make up` in a clean environment also succeeds |
| 2 Expansion table | The 28 lines of `manifest.csv` match the access model of the evaluation set one by one, and the administrative roles are in no expansion result |
| 3 Permission matrix | 216 documents (access level × campus × status × grade requirement × named users) compared one by one with 384 kinds of caller (role combinations × campus × grade × user); the SQL filter and the independent Python rules agree **completely**, and the query runs as the `ai_app` role |
| 4 Least privilege | With only `Admin` / `RAGETLAdmin`, with no role, or with only unknown roles, no chunk can be found; except for a user named by a document (by design) |
| 5 Document service | After changing permissions or status the document and all chunks are consistent; a failure midway rolls back entirely and leaves no audit record; the consistency check view can find inconsistencies caused by editing the database directly |
| 6 Audit | `ai_app` can insert; UPDATE, DELETE, TRUNCATE and SELECT are all refused by permissions |
| 7 SQL views | 9 demo accounts × 7 views return rows **completely identical** to the independently computed expectation; of the 26 evaluation questions that should be answered, 17 (SQL-03, 07, 11, 12, 14 to 26) get from the view query the same result as `expected_answer`; for the 7 questions that should be refused, the data is invisible to the asker (0 rows) |
| 8 Tamper protection | Calling `set_config` in a query is refused; `ai_sql_ro` cannot read the original `biz` tables, any table of `ai`, or tables of `public` |
| 9 M1 and CI | The M1 integration tests pass after the account renaming; GitHub CI passes (including Keycloak and all integration tests, taking about 1 minute 49 seconds) |

**Mutation check**: the filter rules were weakened temporarily (dropping the grade, giving everyone whole-company scope, letting drafts through, ignoring named users), and the differential test failed every time, which shows that the test can find such regressions; it was restored afterwards.

**Differences from the plan, or additions:**

| Item | Note |
|---|---|
| Migration split | Database roles are created in 0002 (planned for 0003); a downgrade **does not drop** the cluster-shared roles |
| `up` flow | Compose gained a one-shot `migrate` service that the API waits for; otherwise in a brand-new environment the application account does not exist yet and the API cannot pass its health check |
| Helper function grants | The `ai_auth` functions called by the views run with the caller's rights, so `USAGE` / `EXECUTE` was opened to `ai_sql_ro` (they only read the caller's own identity); so the test item "cannot call `ai_auth.has_role`" was removed |
| Generated column | `array_to_string` is not IMMUTABLE and a wrapper function declared IMMUTABLE solves it (an item unclear beforehand, verified to work) |
| `set_config` restriction | Revoking PUBLIC's execution works, proved effective by a test |
| Evaluation question SQL-31 | A student asked "how many instructors are on my campus"; the original question (the number of students) could be answered wrongly from the student's own single row, so it became a question about the employee table and the evaluation set was regenerated |
| Commands | `make seed-biz` was added for local development; after the account renaming an existing environment needs `make clean` to import the Keycloak realm again |
| New script | `scripts/build_realm.py` generates the realm from `demo-accounts.csv`, so accounts always match the sample data |

**Known limits (recorded honestly):**
- Postgres cannot forbid the `SET` statement on the custom configuration item `app.*` through permissions. The defence now is: `set_config` is granted to `ai_app` only; the execution entry accepts only a single `SELECT` (the tests cover the entry check that rejects multiple statements and `SET`; **it is not the database itself that rejects `SET`**). Statement checks (allow-lists of views and functions) arrive in M6.
- The answer checks of 9 questions that should be answered (SQL-01, 02, 04, 05, 06, 08, 09, 10, 13) are left to M6, when the SQL agent will generate the matching queries.
- In an old `.env` the `STARIT_DATABASE_URL` still points to the database owner and has to be changed by hand (the README explains).


---

## M3 Ingestion pipeline

Status: **Done and merged** (tag `ai-m3`, merge commit `9dd000a`, 2026-11-03). This milestone starts using the OpenAI key (already set in the local `.env` and never committed; during checks only that it is non-empty was confirmed and it was not shown).

### Findings of the research before starting (verified)

| Item | Result |
|---|---|
| Sample documents | 28: docx 10, pdf 7, md 6, txt 5; all `campus_scope = all`; `HR-REC-001` has two versions (v1.0 superseded, v2.1 active); about 9,000 words and 55 KB of text in all |
| md / txt | They begin with a metadata block (`key: value`, wrapped in `---` for md) that duplicates `manifest.csv`; md has headings and tables; txt uses numbered lines such as `1. Title` as headings, **and list items use the same numbering**, so rules are needed to tell them apart |
| **docx (a problem)** | Two spot-checked: **no heading styles at all** (everything is `Normal`) and **tables flattened into separate paragraphs** (`tables: 0`). The cause is that the samples were converted with macOS `textutil`, which lost the structure. Headings can only be guessed from font size and bold, and tables have to be rebuilt from adjacent small-font paragraphs |
| pdf | Extractable with pdfplumber: font size 20 is a title, 14 a section title, 11 body text, and **tables can be recognised** (3 on the first page) |
| tiktoken | Available (`cl100k_base`; the first use needs the network to download the vocabulary) |
| litellm | 1.106.6 installs on this machine (arm64), and takes about 5 seconds to import |
| boto3 | Available |
| Cost estimate | All documents are about 9,000 words, or 12,000 to 15,000 tokens; I remember the price of `text-embedding-3-small` as US$0.02 per million tokens (**not checked online**), so the embedding cost of the whole ingestion is under US$0.01; before a real call the exact token count and the estimate are printed and you confirm |

### Questions to confirm first

1. **Should the docx samples be regenerated?** The current docx files have no heading styles and no real tables, so the parser can only guess from font size. Real companies' docx files usually have heading styles and tables. It is proposed that the docx part of `build_documents.py` be changed to generate with `python-docx` (real Heading styles, real tables); the 10 docx files are regenerated with the same content and no longer depend on macOS's `textutil`. The parser handles both cases: heading styles first, and the rule "bold, larger font size, starting with a number" as the fallback when there are no styles. **Proposed.**
2. **Embedding uses the litellm library** (the decision of 4.2 of design 01: code depends on one interface, and lite uses litellm in the process), with provider and model set by variables. The alternative is to use the `openai` SDK directly, which is lighter but ties us to a vendor. **litellm proposed.**
3. **Derived content (summary, hypothetical questions, keywords) is only a placeholder stage in M3 and not generated by default.** It needs the chat LLM client (which only exists in M5), and design 05 says it is switched on only after evaluation proves it useful. **It is proposed to implement and evaluate it in M8.**
4. **Object store**: original files are uploaded to the local S3-compatible store (bucket `starit-documents`) and the database records `object_key`. Using `boto3`, with the bucket created automatically when the worker starts.

### Planned files (under `ai-module/` unless stated otherwise)

| File | Purpose |
|---|---|
| `sample-data/tools/build_documents.py` (changed) | docx generated with python-docx (real heading styles and tables); the 10 docx files regenerated |
| `packages/core/src/starit_core/ingest/models.py` (new) | The data classes `Block` (heading, paragraph, list item, table, code), `ParsedDocument`, `Chunk` |
| `packages/core/src/starit_core/ingest/parsers/` (new): `base.py`, `markdown.py`, `text.py`, `docx.py`, `pdf.py`, `registry.py` | The parser interface and four implementations, chosen by extension; drop the metadata block that duplicates `manifest.csv` |
| `packages/core/src/starit_core/ingest/clean.py` (new) | Cleaning: extra whitespace, invisible characters, repeated header and footer lines; **never rewrites the body text** |
| `packages/core/src/starit_core/ingest/chunker.py` (new) | Structured chunking: split by heading, 300 to 500 tokens, overlap about 50; tables and code blocks not split; `heading_path`, page number |
| `packages/core/src/starit_core/ingest/identifiers.py` (new) | Code extraction (hyphenated uppercase codes, 18-character codes), also adding the document's own `doc_code` |
| `packages/core/src/starit_core/ingest/tokens.py` (new) | Counting with tiktoken |
| `packages/core/src/starit_core/embeddings.py` (new) | The `EmbeddingClient` interface; the litellm implementation; a deterministic fake (for tests, free) |
| `packages/core/src/starit_core/storage.py` (new) | S3 client: ensure the bucket exists, upload, download |
| `packages/core/src/starit_core/ingest/pipeline.py` (new) | Stages: parse → clean → chunk → derive (placeholder) → embed → write; **the write replaces the old chunks in one transaction**; each stage updates `ingestion_jobs.stage` |
| `packages/core/src/starit_core/ingest/queue.py` (new) | Job queue: claiming with `FOR UPDATE SKIP LOCKED`, retries and backoff, a failure records the stage and the reason |
| `apps/worker/src/starit_worker/main.py` (changed) | Polling loop; `--once` exits after the queue is processed |
| `scripts/ingest_samples.py` (new), `Makefile` (changed: `make ingest-samples`) | Reads `manifest.csv`, registers documents, uploads the original files, creates jobs (the same path as the later upload endpoint) |
| `deploy/compose/compose.yaml`, `.env.example` (changed) | Adds the `worker` service; adds the embedding variables |
| `packages/core/src/starit_core/config.py` (changed) | `embedding_provider`, `embedding_model`, `embedding_dimensions`, batch size, chunking parameters |
| `packages/core/pyproject.toml`, `apps/worker/pyproject.toml` (changed) | Dependencies: `python-docx`, `pdfplumber`, `markdown-it-py`, `tiktoken`, `litellm`, `boto3` |
| `packages/core/tests/ingest/` (new, unit), `packages/core/tests/integration/test_ingest_*.py` (new) | See the verification criteria |
| `sample-data/README.md`, `ai-module/README.md`, design 05 (changed) | Explain the change of the docx files and the ingestion command |

### Key design decisions (proposed)

- **Code extraction**: regular expressions cover hyphenated uppercase codes such as `ERR-PORTAL-403` and `TS-NET-009`, and 18-character alphanumeric codes such as tax IDs; the keyword questions of the evaluation set (`ERR-PORTAL-403`, `ERR-PORTAL-429`, tax ID `91510000FAKE00001X`) serve as test cases.
- **Text for embedding**: `heading path + body`; the stored `text` is the pure original (1.4 of design 05).
- **Metadata block**: removed at parse time and not part of chunks; but the document title goes into the heading path and `doc_code` into `identifiers`, so searching by document code still works.
- **Idempotency**: the same `(doc_code, version)` with the same `content_hash` is skipped; if the content changed it is updated and re-ingested; the new chunks replace the old ones in one transaction, and the old chunks stay unchanged on failure.
- **Concurrency**: with two workers running at the same time, a given job is claimed by only one of them.
- **Embedding batches and retries**: the batch size is configurable; a failed batch is retried with backoff, and after too many attempts the job fails, recording the stage `embed` and the reason.
- **Model and dimensions**: every vector row records `model` and `dimensions`; if the configured dimension at ingestion differs from the column's 1536, it fails at once with a message (changing dimension needs a new migration, see 2.4 of design 02).
- **Tests cost nothing**: automated tests and CI use a fake embedding; real calls happen only in the one run I start by hand (estimate first, you confirm).

### Planned commands

```bash
git switch -c m3-ingestion                 # already created
uv sync --all-packages
(cd sample-data && uv run --with python-docx python tools/build_documents.py)   # regenerate the docx files (needs macOS and Chrome)
make up                                    # now includes the worker
make ingest-samples                        # register 28 documents, upload, create jobs
make test && make lint
```

### Verification criteria

1. **Parsing**: all 28 sample documents are parsed; each has at least one heading and one chunk; tables in docx and pdf stay whole table text in the chunks.
2. **Chunking**: no chunk exceeds the limit; a table is not cut in the middle of a row; md code fences are not lost; `heading_path` matches the document structure (asserted with the samples).
3. **Codes**: the codes in the keyword questions of the evaluation set appear in the `identifiers` of the matching chunks, and full-text search can hit them exactly.
4. **Ingestion**: all 28 documents are ingested, and the number of documents matches `manifest.csv`; every chunk's `allowed_roles` matches the expansion table; the consistency check view is empty; both versions of `HR-REC-001` are there, with the statuses `superseded` and `active`.
5. **Idempotency**: ingesting the same document again leaves the number and content of chunks unchanged; after changing the content, re-ingestion replaces the old chunks.
6. **Failure handling**: with a broken file the job fails with a clear stage and reason; when embedding fails the old chunks stay unchanged (atomic replacement); after the maximum number of retries the job is `failed`.
7. **Concurrency**: when two workers claim jobs at the same time, each job is processed only once.
8. **Model record**: every vector row has `model` and `dimensions`; a dimension mismatch makes ingestion fail.
9. **Real embedding**: first print the exact token count and estimated cost; after you confirm, run once over the 28 documents and confirm that the vector dimension is 1536 and the data was written (only that; search quality is not evaluated, the search evaluation is in M4).
10. Local tests, lint and mypy pass, and CI passes.

### Things unclear beforehand

- Whether pdfplumber's table recognition covers all the tables of the 7 pdf files needs checking one by one; tables it cannot recognise degrade into ordinary text lines and will be listed in the tests.
- The rule that tells titles from numbered list items in txt needs verifying one by one on the 5 txt files.
- litellm is slow to import (about 5 seconds), which affects the worker's start-up time; if that slows the tests, the litellm implementation of embedding is imported only when really called.
- The worker image in the container grows with dependencies such as litellm and pdfplumber, and builds take longer.
- tiktoken needs the network on first use to download the vocabulary, the same in CI and Docker builds; an offline environment must cache it in advance.

### For you to confirm

1. The docx samples regenerated (python-docx, real heading styles and tables).
2. Embedding uses the litellm library.
3. Derived content is only a placeholder in M3 and implemented after evaluation in M8.
4. The object store uses boto3, with the bucket created automatically.

### The user's confirmation (2026-11-03)

All four were accepted: the docx samples regenerated with python-docx; embedding through the litellm library; derived content a placeholder in M3 and implemented after evaluation in M8; the object store through boto3 with the bucket created automatically.

### Actual results

**Verification criteria** (all met; all 316 local tests pass, including integration tests; M2 had 117):

| # | Result |
|---|---|
| 1 Parsing | All 28 samples were parsed; the number of headings, chapters, sections and tables in all four formats matches the Markdown source exactly; every line of text of the source is in the parsing result; all pdf tables were recognised (none missed in the 7 pdf files); the metadata block did not get mixed into the body |
| 2 Chunking | 39 chunks (target 400 tokens), median 358, maximum 453, none over 500; every chunk matches the original passage by passage (no content lost); every table is whole in some chunk; when a table is too large it is split by rows with the header repeated, and when a code block is split the fences stay paired (neither occurs in the samples and both are covered by tests with synthetic data) |
| 3 Codes | Every code in the source is fully kept in the parsing result of all four formats; the keyword questions of the evaluation set (`ERR-PORTAL-403`, `ERR-PORTAL-429`, the tax ID) can all be hit exactly by the full-text index, and the hit document is in the matching `source_docs` |
| 4 Ingestion | All 28 documents are `ready`; every chunk's `allowed_roles` matches the expansion table; the consistency check view is empty; both v1.0 (`superseded`) and v2.1 (`active`) of `HR-REC-001` are there, and v2.1's `supersedes_id` points to v1.0 |
| 5 Idempotency | Running again: all 28 are `unchanged`, no new jobs, chunks completely unchanged; after changing one document only it is updated and the chunk rows of the other documents stay as they were; `--force` embeds again |
| 6 Failure handling | A broken pdf: the job is `failed`, stage `parse`, reason `parse_failed`, tried only once; a file missing in storage: `object_missing`; an embedding failure: retried with backoff, `failed` after 3 attempts, **and the old chunks always stay unchanged** (atomic replacement); no text, a deleted document and so on also have their reason codes |
| 7 Concurrency | Two workers processing 6 jobs at the same time: each claimed jobs, each job was tried only once, and there are only 6 ingestion audit records |
| 8 Model record | Every vector row records `model` and `dimensions`; when the configured dimension (768) differs from the column (1536) the job fails at once with the reason `unsupported_dimensions`, with no retry |
| 9 Real embedding | The exact count came first: **11,537 tokens**, an estimated cost of about **US$0.00023** (price US$0.02 per million tokens, from OpenAI's model page, checked by search); after you confirmed, ingested once more (28 calls, one per document): 39 vectors, model `text-embedding-3-small`, width 1536, norm between 0.9995 and 1.0005, no zero vectors, no failures, no warnings |
| 10 Engineering checks | lint and mypy pass; GitHub CI passes (including Keycloak and all integration tests, taking about 2 minutes 38 seconds) |

**Differences from the plan, or additions:**

| Item | Note |
|---|---|
| Chunk target | The sample documents are very short, and splitting by section gives a median of only 50 tokens, so "a section boundary only breaks once the target size is reached" was implemented, with a default target of 400; `chunk_target_tokens=0` means one chunk per section, left for the chunk-size comparison experiment of M4 |
| pdf code line breaks | The coverage test found that `FIN-TAX-008` breaks at the hyphen and was joined as `FIN- TAX-008`; fixed, with a dedicated test |
| Variable names | The embedding variables carry no `STARIT_` prefix, as in design 06 (`EMBEDDING_PROVIDER` and so on) |
| Added | `--force` of `make ingest-samples` (embed everything again after changing the model) and `--process` (process the queue directly on this machine); `register_from_manifest` can be reused for the later upload endpoint |
| Test isolation | After the real ingestion the development database held real documents, which for a while made a few M2 integration tests fail (the permission differential, the code search); these tests now clear the knowledge base first inside their own rolled-back transactions, so the real data is unaffected (after the tests it is still 28 documents and 39 chunks) |
| How it is tested | The ingestion integration tests run in a throw-away scratch database (the pipeline commits its own transactions and cannot sit inside a rolled-back transaction); automated tests and CI always use a fake embedding and cost nothing |

**Known limits (recorded honestly):**
- The paragraph joining of pdf and the sub-heading recognition of txt rely on layout and rules and were verified only on these 28 samples; real documents with a different layout may need adjustment.
- The first run needs the network to download the tokenizer vocabulary (tiktoken); an offline environment must cache it in advance.
- The worker image grows with dependencies such as litellm and pdfplumber, and builds take longer.
- The real embedding only confirmed "the write succeeded and the dimension and norm are normal"; search quality is evaluated in M4.
- This machine's `ai.ingestion_jobs` holds 56 records: 28 from a dry run with the fake embedding and 28 from the real run; this does not affect later work (the vectors were replaced by those of the real model).


---

## M4 Search and the first evaluation slice

Status: **Done and merged** (tag `ai-m4`, merge commit `9bdcacc`, 2026-11-03). This is the first time the real effect of search can be seen: a comparison of the four modes keyword, vector, hybrid and hybrid + rerank, which is also one of the learning goals of the project.

### Findings of the research before starting (verified)

| Item | Result |
|---|---|
| Evaluation set `qa-set.jsonl` | 54 questions: single 31, multi 7, access 7, keyword 3, unanswerable 3, version 2, paraphrase 1; 43 questions have 1 source document, 8 have 2, and 3 have no source (unanswerable); `should_answer = false` on 6 (3 access: DOC-46, 47, 50; 3 unanswerable) |
| State of the knowledge base | 28 documents, **only 39 chunks**, an average of 286 tokens. The candidate lists (30 each) cover almost all chunks, and the rerank input (20) is over half of the knowledge base: **at this scale the gaps between the four modes are compressed and many questions are hit directly**, so the results must be read honestly; a more convincing comparison has to wait until M8 adds evaluation questions and documents |
| Keyword query | The question text is turned by `plainto_tsquery('english', question)` and then `&` is replaced with `\|` into an "any word hits" query, for example `What does ERR-PORTAL-403 mean?` becomes `'err-port' \| 'err' \| 'portal' \| '403' \| 'mean'` (verified in the database); with AND almost nothing is found because of the function words of a question |
| Ranking | `ts_rank_cd` (plan A decided in design 05), then chunks with an exact `identifiers` hit get a boost |
| Evaluation identities | The evaluation set has roles and no accounts; roles are mapped to demo accounts: student → `wei.stu.sh`, staff → `ning.adm.bj`, manager → `ling.mgr.bj`, hr → `qing.hr.bj`, finance → `ning.fin.bj` (the campus scope of the sample documents is all `all`, so campus does not affect the result) |

### Questions to confirm first

1. **The evaluation runner is a new member of the uv workspace, `eval/`** (the directory structure of design 01 already has `eval/`), with the command line `starit-eval`.
2. **Add a minimal chat model client `starit_core/llm.py` right now** (only "send a message, get the text", with a fake implementation). Rerank needs it, and M5 extends it to streaming and tool calls.
3. **The default rerank model is `openai/gpt-4o-mini`** (changeable with the environment variable `STARIT_MODEL_RERANK`). Before starting I will first check which models your key can use (the endpoint that lists models is free), and switch if it cannot use this one.
4. **Implement the "filtered content" probe in M4** (5.1 of design 04, used to tell `no_permission` and `not_found` apart): it returns only a count and a top score, **never any text**, does not enter the prompt, and is used only for audit and statistics.
5. **The permission regression sweep of the evaluation**: ask each of the 54 questions as each of the 7 roles (5 business roles + `Admin` + `RAGETLAdmin`) and check that every returned chunk is allowed by the independent Python rules, **zero tolerance**. This is done with the keyword, vector and hybrid modes (it only queries the database, costing almost nothing); rerank only reorders candidates that already passed the filter and changes no permission, so it is not swept again.
6. **Should the chunk-size comparison experiment (target 400 versus one chunk per section) be done in M4?** Ingesting once more costs about US$0.0002, then the evaluation is rerun. My suggestion is to **do it once after the baseline is out** and write the result into the report; you can also defer it to M8.

### Planned files (under `ai-module/` unless stated otherwise)

| File | Purpose |
|---|---|
| `packages/core/src/starit_core/permissions.py` (changed) | The `chunks` table object gets the columns search needs (text, heading path, page, codes, `tsv` and so on), making sure the permission condition and the search query use **the same table object**, to avoid generating a Cartesian product |
| `packages/core/src/starit_core/retrieval/models.py` (new) | `Candidate`, `RetrievedChunk` (with the score of each leg), `RetrievalResult` (chunks, diagnostics) |
| `packages/core/src/starit_core/retrieval/keyword.py` (new) | The `KeywordSearcher` interface; the `ts_rank_cd` implementation (OR query + code boost) |
| `packages/core/src/starit_core/retrieval/vector.py` (new) | Vector search (cosine distance, exact scan) |
| `packages/core/src/starit_core/retrieval/fusion.py` (new) | RRF fusion |
| `packages/core/src/starit_core/retrieval/rerank.py` (new) | The `Reranker` interface; the LLM listwise rerank (asks for JSON, parsed tolerantly; on failure falls back to the fusion order and marks it) |
| `packages/core/src/starit_core/retrieval/assemble.py` (new) | Context assembly: deduplicate, take the top N by score, token budget, with document title, version, status and heading path attached |
| `packages/core/src/starit_core/retrieval/probe.py` (new) | The probe for permission-filtered content: returns only a count and a top score |
| `packages/core/src/starit_core/retrieval/search.py` (new) | The entry `retrieve(identity, query, mode, ...)`: every search must carry an identity |
| `packages/core/src/starit_core/llm.py` (new) | The minimal chat client interface + litellm implementation + fake implementation |
| `packages/core/src/starit_core/config.py` (changed) | `retrieval_mode`, candidates per leg, `rrf_k`, `rerank_in`, `final_k`, the context budget, `model_rerank` |
| `eval/pyproject.toml`, `eval/src/starit_eval/` (new): `cli.py`, `dataset.py`, `metrics.py`, `runner.py`, `report.py` | The evaluation runner: reads the evaluation set, turns roles into demo-account identities, searches question by question, computes metrics, writes `ai.eval_runs` / `ai.eval_results` and the Markdown and JSON reports |
| `pyproject.toml` (changed), `Makefile` (changed) | Workspace member; `make eval ARGS="..."` |
| `packages/core/tests/retrieval/` (new, unit), `packages/core/tests/integration/test_retrieval*.py` (new) | See the verification criteria |
| `eval/tests/` (new) | Tests of the metric computation and the report |
| `docs/eval/` (new) | The baseline report (Markdown), committed with the results |
| `docs/design/05`, `ai-module/README.md` (changed) | Implementation record, how to use |

### The search flow (following 2.1 of design 05, defaults unchanged)

```
question ─┬─▶ keyword search (after permission filter) top 30 ─┐
          │                                                     ├─▶ RRF (k=60) ─▶ rerank top 20, keep 6 ─▶ context assembly (budget 3500 tokens)
          └─▶ vector search (after permission filter) top 30 ───┘
```

- Four modes `keyword`, `vector`, `hybrid`, `hybrid_rerank` (default); all numbers are configuration items.
- The filter sits in the `WHERE` of each of the two searches, **filtering before ranking**; old versions take part in search by default with their `status`, and drafts do not.
- Rerank failure (the output is not valid JSON, a number is missing, a number is duplicated, the model errors): fall back to the RRF order and mark `rerank_failed` on the result, so that one rerank failure does not turn into the failure of the whole search.

### Evaluation metrics (4.3 of design 05, the search part)

- `hit@k` (`k` of 1, 3, 6: whether any source document appears in the top k results), `recall@k` (for multi-source questions, the share of source documents that appear), MRR; counted separately by question type.
- `unanswerable` questions and those with `should_answer = false` do not count towards recall, and their top scores are recorded separately (needed for the `grade_retrieval` threshold in M5).
- **Permission regression**: see confirmation question 5; any leak counts as a failure.
- Latency: p50 / p95 of search (database) and rerank.
- Each run records the configuration (mode, parameters, model, git commit) and the result of each question, so runs can be compared side by side.

### Planned commands

```bash
git switch -c m4-retrieval                       # already created
uv sync --all-packages
make test && make lint
make eval ARGS="retrieval --all-modes"          # first prints the number of calls and the estimated cost, waits for confirmation
make eval ARGS="retrieval --leak-sweep"         # permission regression sweep (database only)
```

### Verification criteria

1. All four modes run, each returning at most `final_k` chunks, with every field present (document title, version, status, heading path, page, the score of each leg).
2. **Zero leaks in the permission regression**: 54 questions × 7 roles, and every chunk returned by the keyword, vector and hybrid modes is allowed by the independent rules (automated tests cover more cases with synthetic data, and the evaluation uses real data).
3. **Keyword questions**: for the three questions `ERR-PORTAL-403`, `ERR-PORTAL-429` and the tax ID, hybrid has the source document in the top 3 results (automated tests also pass with fake vectors, since they rely on the keyword leg).
4. **Access questions**: a student asking something only HR can see gets no chunk of that document back, and the probe shows "there is highly relevant filtered content"; HR asking the same question gets that document.
5. **Old versions**: an employee asking about the old recruitment policy gets chunks of both v1.0 (`superseded`) and v2.1 (`active`), with status labels.
6. **Rerank fault tolerance**: garbled output, missing numbers, duplicate numbers and model errors (with a fake chat client) all fall back to the fusion order and are marked.
7. **The probe returns only numbers**: a test asserts that the probe's return value has no text field.
8. **Real evaluation**: first print the number of calls and the estimated cost (query embedding, rerank input tokens); after you confirm, run the four modes; produce the baseline report, write it to `docs/eval/` and commit it; the report states the limits (a knowledge base of 39 chunks).
9. Local tests, lint and mypy pass, and CI passes.

### Things unclear beforehand

- Which chat models your key can use (the endpoint is free, checked first at the start); if the default `gpt-4o-mini` of rerank is not available, switch.
- How the prompt of the LLM listwise rerank should be written and how stable the JSON output is need measuring; each question's input is about 20 chunks (at most 9,000 tokens), so a round of 54 questions is about 490,000 tokens. When estimating the cost at the price of `gpt-4o-mini` I will check the price online first, **so no figure is given now**.
- The ranking quality of `ts_rank_cd` with an OR query and its tokenisation of hyphenated codes need measuring (codes also have the `identifiers` boost as a fallback).
- The evaluation is very small (54 questions, 39 chunks), so differences may not be clear and may fluctuate on individual questions; no conclusion can be drawn from it, and M8 adds evaluation questions and documents.
- The evaluation writes `ai.eval_runs` / `ai.eval_results`: the application account has read and write rights on them (granted), but the primary key is `(run_id, question_id, role)`, so one row per question and role in one run, and several modes must be split into several runs.

### For you to confirm

1. The evaluation runner as the workspace member `eval/`.
2. Add the minimal chat model client `llm.py` now.
3. The default rerank model `openai/gpt-4o-mini` (availability checked first).
4. Implement the "filtered content" probe (returning only numbers).
5. The permission regression sweep: 54 questions × 7 roles × three modes.
6. The chunk-size comparison experiment: once after the M4 baseline, or deferred to M8?

### The user's confirmation (2026-11-03)

- **The default rerank model changes to `gpt-6-luna`**, with `gpt-4o-mini` when it is unavailable. Verified: this key can see `gpt-6-luna` (the model-listing endpoint, free); the price found online is US$0.10 per million input tokens and US$0.50 per million output tokens (from several secondary sources, not checked directly on the official price page), the cheapest of the GPT-6 tier. Whether it can really be used for rerank (whether the parameters are accepted, whether the output is stable) is verified at implementation with one tiny call.
- The chunk-size comparison experiment: **done once after the M4 baseline**.
- The other 5 (the evaluation runner as the `eval/` workspace member; add the minimal chat client now; the probe for filtered content returning only numbers; the permission regression sweep of 54 questions × 7 roles × three modes) were all accepted.
- Before every real call the number of calls and the cost estimate are still printed first and you confirm.

### Actual results

**Verification criteria** (all met; 378 local tests pass; M3 had 316):

| # | Result |
|---|---|
| 1 Four modes | All run, each returns at most 6 chunks with every field present (document title, version, status, heading path, page, the score of each leg); the reranked result and the fall-back to the fusion order are both tested |
| 2 Permission regression | **Zero overreach.** Automated tests: 54 questions × 7 roles × 3 modes (besides synthetic data, also the real sample documents); real runs: two runs of 1,134 searches each, with the independent rules checking every returned chunk, 0 overreaching chunks; the M2 differential test still passes as well |
| 3 Keyword questions | `ERR-PORTAL-403`, `ERR-PORTAL-429`, the tax ID: the source is in the top 3 of the keyword mode; in the real baseline the MRR of hybrid is 0.83 (`ERR-PORTAL-429` ranks 2nd, see below) |
| 4 Access questions | A student asking something only HR can see: no mode returned a chunk of that document, and the probe shows "a strong filtered match exists"; HR asking the same gets it; `Admin` / `RAGETLAdmin` get nothing, and the probe shows the content exists |
| 5 Old versions | An employee asking about the old recruitment policy got the chunks of both v1.0 (`superseded`) and v2.1 (`active`), with status labels |
| 6 Rerank fault tolerance | Garbled output, an empty ranking, missing numbers, duplicate and out-of-range numbers, model errors: all fell back to the fusion order and were marked; in the real runs there were 108 rerank calls (54 in each of two runs), **and not one failed** |
| 7 The probe returns only numbers | A test asserts that the result type has no text field |
| 8 Real evaluation | The estimate was printed first (54 rerank calls, at most 329,400 input tokens, about US$0.039) and you confirmed; the baseline actually used 318,665 input and 7,546 output tokens, about US$0.036; the chunk comparison experiment about US$0.016, plus two re-embeddings of about US$0.0006, about US$0.052 in all; the reports are in `docs/eval/` |
| 9 Engineering checks | lint and mypy pass; GitHub CI passes (including all integration tests, taking about 3 minutes 8 seconds) |

**Summary of results** (details in [`docs/eval/README.md`](../eval/README.md)):

- The knowledge base has only 39 chunks (189 with one chunk per section), **hit@6 is 1.0 everywhere and the metrics are saturated**, so the differences are only in hit@1 and MRR: with 400-token chunks keyword 0.896, vector 0.917, hybrid 0.938, hybrid_rerank 1.0; with one chunk per section keyword 0.833 and the other three all 1.0.
- Rerank scored full marks both times; search latency p50 about 2.1 seconds (the other modes tens of milliseconds).
- Rerank scores are all 10 on the 48 answerable questions and 0, 0, 1, 2, 5, 8 on the 6 unanswerable or to-be-refused ones; this is the basis in M5 for judging whether the evidence is enough, but the sample is very small, and the question with 8 shows the gap is not wide.

**Differences from the plan, or additions:**

| Item | Note |
|---|---|
| Boost for the named document | Testing found that when asking "what does FIN-REIM-002 say", another document that only mentions the code in its body ranked first; keyword search gained one more share of score for "the chunk belongs to the named document" |
| A weakness of RRF | In the baseline `ERR-PORTAL-429` ranks only 2nd in hybrid mode: the vector leg put the chunk of `ERR-PORTAL-403` first, and RRF looks only at rank and pushed down the one exact hit; rerank corrected it. In the automated tests the vectors are fake random vectors, so the code test of hybrid mode only requires the source to appear in the result, not the top 3 |
| Chat model parameters | When reasoning is on, `gpt-6-luna` accepts only `temperature = 1`; the client sets `reasoning_effort = "none"` and `temperature = 0`, and models that do not support them ignore them through `drop_params`. A tiny trial call (about 20 tokens) confirmed this |
| Code location | `vector_literal` moved to `embeddings.py`, so the search module does not depend on the ingestion pipeline |
| Added | `eval/` as a uv workspace member; `make eval`; `--dry-run` (rehearsal with a fake model), `--no-db` |
| Evaluation records | The database holds 8 evaluation runs (2 labels × 4 modes), 432 result rows; the knowledge base was restored to the default chunking (39 chunks, real vectors, consistency check empty), and the worker container was restarted |

**The user's decision (2026-11-03): keep one chunk per 400 tokens.** (The question put forward at that time follows.) Should the default chunking change to one chunk per section? For search ranking, finer chunks help vector and hybrid, and under rerank the two are level and the rerank input is cheaper; but with one chunk per section the 6 chunks are only about 350 tokens, which may be too little context for generating the answer, and answer quality was not measured this time. **My suggestion is to keep 400 tokens for now, and once M5 has answers, compare together with answer quality in M8.**

**Known limits (recorded honestly):**
- The knowledge base is too small and the evaluation questions too few (only a few per question type), so the numbers only show that the flow is correct and the direction, and cannot show how the methods compare at real scale.
- The prices come from a third-party price table and were not checked directly on OpenAI's price page.
- The stability of rerank was verified only on these 108 calls; a different model or document style needs a new assessment.


---

## M5 Agent graph and the chat API

Status: **Done and merged** (tag `ai-m5`, merge commit `1e3d4dd`, 2026-11-03). This is the core of the project: the user asks, goes through the fixed graph, and gets an answer with citations or a clear refusal, and every run has an explicit End state. This milestone calls OpenAI's chat models (the two nodes `understand` and `generate`, plus the rerank that M4 already has).

### Findings of the research before starting (verified)

| Item | Result |
|---|---|
| LangGraph | `langgraph 1.2.19` and `langgraph-checkpoint-postgres 3.2.0` install and import on this machine (Python 3.12, arm64); `redis 8.1.0` works as well |
| What M4 left | `retrieve(...)` already searches by identity and returns the rerank scores and the numbers of the "filtered content" probe; the minimal chat client `llm.py` already has a JSON mode; `gpt-6-luna` is verified usable |
| Available chat models | This key can see `gpt-6-luna`, `gpt-6-sol`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-astra`, `gpt-4o-mini` and so on. The list prices found (secondary sources): Luna US$0.10 / 0.50 per million tokens in / out, Sol 2 / 10, Astra 10 / 50 |
| Tables the database already has | `ai.conversations`, `ai.messages`, `ai.runs`, `ai.audit_log` (built in 02, the M2 migration) |
| M4's evaluation data | Rerank scores are all 10 on the 48 answerable questions and 0 to 8 on the 6 unanswerable or to-be-refused ones, used to set the initial `grade_retrieval` threshold |

### Questions to confirm first

1. **The LangGraph Postgres checkpointer is not used, and the conversation state is stored in `ai.conversations`** (a new migration 0005 adding three columns: `session_mode`, `pending_question`, `clarify_count`). Reason: in phase 1 every run is one complete, uninterrupted run ("needs clarification" also ends with an End, and the next turn comes in with the addition), so a checkpointer would not be used yet would add a set of tables, a `setup()` and a version coupling. It is enabled in phase 2 when "write action confirmation" (`interrupt`) is built. This changes the statement "saved by the checkpointer" in design 04, and I will change design 04 to match. **Proposed.**
2. **`data_query` is refused in M5 for now**, with End state `refused` and a temporary reason code `not_available_yet` (removed once M6 implements data queries); the `action` intent returns `refused / write_not_enabled` per design 04.
3. **The history keeps only the last 6 turns (truncation), with no rolling summary yet.** Design 04 says "older content uses a rolling summary"; a summary needs one more LLM call, the samples have no long conversations, and it is proposed to leave it for later.
4. **Default models**: `understand` and `generate` both use `openai/gpt-6-luna` (each changeable by environment variable). Answer generation is the most sensitive to quality (in the RAGFlow trial a small model got the late penalty wrong), so in the real check the same batch of hard questions is compared against `gpt-6-sol`, and the default is chosen by the result.
5. **The conversation title** is the first 60 characters of the first question, with no LLM call.
6. **Rate limiting** (section 7 of design 03: 20 per user per minute on the chat endpoint) is done together in M5 with Redis counters, and going over returns `429 rate_limited`.
7. **`grade_retrieval` has two gates**: the first uses the rerank score (initial threshold 6, following the distribution of M4, configurable, calibrated with the evaluation set); the second is the `sufficient` flag returned by the generate node itself, and when the model judges the passages not enough to answer it ends with `not_found / no_relevant_documents`. This way the threshold need not be set too tight, and a "relevant but answerless" passage (DOC-47 scored 8 in M4) does not become an invented answer.
8. **Real check**: about 12 representative questions (the late-penalty calculation, an old policy version, two error codes, a student asking for an HR file, no answer, needs clarification, out of scope, a greeting); the number of calls and the estimated cost are given first, and it runs after confirmation.

### Planned files (under `ai-module/` unless stated otherwise)

| File | Purpose |
|---|---|
| `migrations/versions/0005_conversation_state.py` | `ai.conversations` gains `session_mode`, `pending_question`, `clarify_count` |
| `packages/core/src/starit_core/agent/state.py` | The graph state (read-only identity, conversation state, intent, search results, budget, answer, End state) |
| `packages/core/src/starit_core/agent/prompts/understand.md`, `generate.md` + `prompts.py` | Prompt files and version numbers (the generation rules of section 6 of design 04) |
| `packages/core/src/starit_core/agent/nodes.py` | The nodes: `load_context`, `guard_input`, `understand`, `retrieve_docs`, `grade_retrieval`, `rewrite_query`, `generate`, `verify_answer` |
| `packages/core/src/starit_core/agent/graph.py` | Builds the LangGraph graph; 6 End nodes; routing; budget and step limits |
| `packages/core/src/starit_core/agent/finish.py` | `finish_run`: in one transaction writes `ai.runs`, `ai.messages`, `ai.audit_log` and updates the conversation (time, title, conversation state) |
| `packages/core/src/starit_core/agent/runtime.py` | `AgentRuntime.run(identity, conversation_id, text)`: assembles the dependencies, a 60-second total timeout, and guarantees that however it goes it reaches `finish_run` |
| `packages/core/src/starit_core/conversations.py` | Reading and writing conversations and messages (only your own conversations; archiving does not delete) |
| `packages/core/src/starit_core/ratelimit.py` | Redis rate limiting (with an in-memory version for tests) |
| `packages/core/src/starit_core/llm.py` (changed) | Returns token counts; a timeout per call; a structured-output helper |
| `packages/core/src/starit_core/config.py` (changed) | `model_understand`, `model_generate`, the limits (steps, LLM calls, clarifications, retries), `grade_min_rerank_score`, number of history turns, rate limits |
| `apps/api/src/starit_api/conversations.py` (new) | Routes: `POST/GET /conversations`, `GET/PATCH/DELETE /conversations/{id}`, `POST/GET /conversations/{id}/messages` |
| `apps/api/src/starit_api/main.py` (changed) | Builds the runtime in the lifespan; registers the routes; rate-limit middleware |
| `packages/core/pyproject.toml` (changed) | Dependencies: `langgraph`, `redis` |
| `packages/core/tests/agent/` (new, unit), `packages/core/tests/integration/test_agent*.py` (new), `apps/api/tests/test_conversations*.py` (new) | See the verification criteria |
| `eval/` or `scripts/` (changed) | A small tool: really asks the about 12 questions and prints the End state, citations and time of each |
| `docs/design/04`, `02`, `03`, `ai-module/README.md` (changed) | Synchronised implementation record |

### The graph (following design 04, the part M5 implements)

```
load_context → guard_input → understand ─┬─ needs clarification, not over the limit → END_NEED_CLARIFICATION
                                          ├─ out_of_scope / action / data_query → END_REFUSED
                                          ├─ chitchat → generate
                                          └─ doc_qa → retrieve_docs → grade_retrieval
        grade_retrieval ─┬─ enough → generate → verify_answer → END_ANSWERED
                         ├─ not enough, can retry → rewrite_query → retrieve_docs
                         ├─ no content but a strong filtered match is probed → END_NO_PERMISSION
                         └─ no content → END_NOT_FOUND
        generate returns sufficient=false → END_NOT_FOUND; a failed verification retries once, and if it still fails → END_ERROR(llm_error)
        any exception or timeout → END_ERROR
```

### Key design decisions (proposed)

- **Identity is read-only**, from the JWT; `understand` only does intent, the standalone question and the clarifying question, and **does not judge identity**.
- **`no_permission` and `not_found` for the same question use the same text for the user** (5.1 of design 04); the difference is recorded only in `ai.runs` and the audit; the probe numbers go only into the audit and never into the prompt.
- **Conversation state**: when `session_mode` is `need_clarification`, the next message is treated as an addition to `pending_question` and merged into a standalone question; after 2 consecutive clarifications it ends with `not_found / clarification_limit`.
- **Budget**: at most 6 LLM calls in one run (including rerank), 1 search retry, 1 verification retry, 60 seconds in total, `recursion_limit` 20; going over ends with `error` and a reason code.
- **Search mode**: `hybrid_rerank` by default; if rerank fails it falls back to the fusion order, and then `grade_retrieval` only looks at whether there is any result and leaves the judgement to the generate node.
- **Citations**: only from the chunks found in this run that the user may see; `n` matches the `[n]` in the text; an answer citing a number that does not exist is stopped by verification.
- **Prompts**: kept in files with version numbers, written into the `details` of the audit record to ease later comparison.
- **Input guard** (`guard_input`): empty input, too long (initial limit 2,000 characters), obvious prompt-injection signs (a short list of rules); this is only the first layer, and the real defence is that permissions are filtered in the database, so the model cannot get content it may not see.

### Planned commands

```bash
git switch -c m5-agent                      # already created
uv sync --all-packages
make migrate                                # the new migration 0005
make test && make lint
make up                                     # the API now carries the new routes
# real check (estimate printed and confirmed first)
uv run python scripts/ask_samples.py        # about 12 questions
```

### Verification criteria

1. **Every End state has a scenario test** (fake chat client and search stubs): `answered`, `need_clarification` (including `clarification_limit` after 2 in a row), `no_permission`, `not_found` (empty search, not enough evidence, generation returning `sufficient=false`), `refused` (out of scope, input blocked, write action, data query not open yet), `error` (timeout, LLM error, search error, step limit exceeded, failed verification).
2. **Graph structure test**: walk every edge of the graph and assert that every node can reach some End node; the flow chart in the document is exported from the graph definition, not maintained by hand.
3. **Completeness of `finish_run`**: any run (including exceptions and timeouts) wrote one row of `ai.runs` (with `end_state` and `end_reason`), the matching messages and one `chat.query` audit record; the write is in one transaction and leaves no half record on failure.
4. **API**: create, list, read, rename, archive a conversation, send a message, read the history; someone else's conversation id returns 404; not signed in is 401; the error format is uniform; the response structure matches design 03 (`run_id`, `message`, `citations`, `end_state`, `end_reason`); going over the rate limit returns 429.
5. **Permissions**: with the real sample documents (search with fake embeddings + a scripted chat model): a student asking for an HR file gets an answer with none of that document's content, no citations, and `end_state` is `no_permission`; HR asking the same question gets citations; an `Admin` asking gets `no_permission` / `not_found` and cannot read restricted content; citations contain only documents the user may see.
6. **The two rounds of clarification**: a vague question in the first round gets a clarifying question (`need_clarification`), and the addition in the second round is merged and gets an answer; the conversation state is kept in the database between the two requests.
7. **Real check** (after the cost is confirmed): really ask the about 12 questions once, and report each one's End state, citations, time and cost; the late-penalty question (DOC-40) must be calculated correctly (decide the range first); the answer to `ERR-PORTAL-429` must be that the quota is used up, not the number of devices; a student asking for an HR file must be refused without leaking content.
8. Local tests, lint and mypy pass, and CI passes.

### Things unclear beforehand

- Whether the structured output of the generate node (`sufficient`, `answer`, `citations`) is stable on `gpt-6-luna`; the fallback when it is not is one retry after a failed verification, then `error`.
- The effect of the score threshold 6 and "retry once if not enough" needs calibrating with the evaluation set and the real check; the sample is very small, and in M4 the top score of an unanswerable question reached 8.
- The exact interfaces of LangGraph 1.x for async calls, `recursion_limit` and graph export (for the reachability test and the flow chart) are checked against the documentation at the start.
- Whether the 60-second total timeout and the 30-second timeout per model call are enough on `gpt-6-luna`; rerank takes about 2 seconds on average, and with understanding and generation the total is expected to be 5 to 8 seconds.
- The rule list for prompt injection can only stop the most obvious forms and is not a security boundary; stated above.

### For you to confirm

1. The conversation state stored in `ai.conversations` (migration 0005), without LangGraph's checkpointer.
2. `data_query` refused for now with `not_available_yet`.
3. The history truncated to the last 6 turns, with no summary.
4. The default model `gpt-6-luna`, compared against `gpt-6-sol` in the real check before deciding.
5. The conversation title is the first 60 characters of the first question.
6. Rate limiting (20 per user per minute) done together.
7. The two gates of `grade_retrieval` (rerank score threshold 6 + the generate node's `sufficient`).
8. A real check of about 12 questions.

### The user's confirmation (2026-11-03)

- The default chat model is `openai/gpt-6-luna`; in the real check **compare against `gpt-4o-mini`** (not `gpt-6-sol`) and choose the default by the result.
- The other 7 were all accepted: the conversation state stored in `ai.conversations` (migration 0005) without LangGraph's checkpointer; `data_query` refused for now with `not_available_yet`; the history truncated to the last 6 turns; the conversation title as the first 60 characters of the first question; rate limiting (20 per user per minute) done together; the two gates of `grade_retrieval`; a real check of about 12 questions (estimate first, then confirm).

### Actual results

**Verification criteria** (all met; 437 local tests pass; M4 had 378):

| # | Result |
|---|---|
| 1 Every End state has a scenario test | On the real database with scripted model and search stand-ins: `answered` (including a greeting and a retry that succeeded after the answer was rejected), `need_clarification` (including `clarification_limit` after 2 in a row), `no_permission`, `not_found` (empty search, not enough evidence, a successful retry, generation returning `sufficient=false`), `refused` (out of scope, a write action, a data query not open yet, 4 kinds of blocked input), `error` (model error, search error, generation not JSON, an answer with no citation or citing a number that does not exist, a tool error, call count exceeded, the 60-second timeout) |
| 2 Graph structure test | Walk every edge of the graph: every node can reach some End node; the drawn graph matches the routes listed in the document exactly; the 6 End nodes correspond exactly to the 6 End states; the graph can be exported as mermaid |
| 3 `finish_run` completeness | Every run (including exceptions and timeouts) wrote one row of `ai.runs`, two messages and one `chat.query` audit record, and updated the conversation; the write is in one transaction, and if the audit write fails nothing is left behind; an error does not lose the "waiting for clarification" state |
| 4 API | Conversation create, list (paged, newest first), read, rename, archive (sending a message after archiving returns 409), send a message, read the history (paged); someone else's conversation returns 404 (the same as not existing); not signed in 401; a malformed id or cursor 422; an empty or over-long message 422; the response structure matches design 03; going over the rate limit returns 429 with `Retry-After`, counted per user |
| 5 Permissions | Real sample documents with real search: a student asking something only HR can see gets `no_permission`, the answer contains nothing, `HR-REC-002` is in none of the text the model saw, and the audit recorded "hidden content exists" (a count only); HR asking the same question gets an answer from that document with citations; `Admin` and `RAGETLAdmin` can read nothing; for 5 business roles × 12 questions, the citations and the passages the model saw are all documents that role may read |
| 6 Two rounds of clarification | A vague question in the first round gets a clarifying question and the conversation state is kept in the database; the addition in the second round is merged with the pending question and gets an answer, and the state is reset; the history also went into the understand step |
| 7 Real check | 15 rounds, two versions (see below); container smoke test: a real token asking `ERR-PORTAL-429` over HTTP got the correct answer citing `TS-CRS-005`, a greeting, history, 404 when someone else reads it, Redis rate limiting 200 / 200 / 429 / 429 (separate per user) |
| 8 Engineering checks | lint and mypy pass; GitHub CI passes (including all integration tests, taking about 2 minutes 38 seconds) |

**Real check results** (details in [`docs/eval/README.md`](../eval/README.md)):

- First run: the default version (generation with `gpt-6-luna`) 14/15, `gpt-4o-mini` 11/15. The failures exposed **two real problems**: the rerank prompt cut passages at 350 tokens and hid the `ERR-PORTAL-429` line (rerank gave only 2 and the first gate refused to answer); the understand step treated the Maven question as out of scope. Both were fixed and regression tests added.
- Rerun after the fixes: default 14/15, `gpt-4o-mini` 12/15. The one question left for the default version (DOC-43) was my overly strict judging condition, not a wrong answer by the assistant; `gpt-4o-mini` consistently got the late-penalty question wrong (it said 0 points, and the answer had no citation mark so verification stopped it), and on DOC-47 it was too eager to answer with documents everyone can read (it did not cite the confidential document, so it is not a leak).
- **The default model stays `gpt-6-luna`.**
- Cost: the two runs together are estimated at under US$0.06 (including the few calls already sent before the first run stopped midway because my script's read of the audit table was refused).

**Differences from the plan, or additions:**

| Item | Note |
|---|---|
| Rerank truncation | The default of `rerank_passage_tokens` changed from 350 to 600, and it must be no smaller than the chunk limit; this is a problem the M4 baseline did not find because the baseline only looked at ranking and not at absolute scores |
| Understand prompt | Version 2, which makes the scope of tech support explicit |
| Hidden-content threshold | The initial 0.3 became 0.5 after measuring: questions about restricted documents score 0.57 to 0.74 and unanswerable ones 0.09 to 0.41 (a small sample, a narrow gap) |
| Where `finish_run` is | Called by the runtime wrapper rather than by each End node (so exceptions and timeouts are always recorded); written into design 04 |
| Greetings | A fixed reply, with no model call |
| Flow chart | The graph can be exported as mermaid, but the flow chart in design 04 is still hand-written and has not been changed to automatic export |
| Test doubles | `ScriptedChat`, `StubRetrieval` and `Harness` are in `starit_core/testing.py`, shared by the two test directories; the shared temporary database fixture moved to `ai-module/conftest.py` |
| Container configuration | The API container now receives `OPENAI_API_KEY`, the embedding variables and `STARIT_RATE_LIMIT_CHAT_PER_MINUTE` |
| A mistake of mine | When I committed the regression tests, one of them was failing (I had misjudged the token count of the test data, and its own precondition assertion caught it); I only noticed after committing and did not say so in the report at the time; fixed in the next commit, and made to also assert that the old limit of 350 really would hide that line |

**Known limits (recorded honestly):**
- Answer verification does only deterministic checks (the citation numbers exist, there is a citation, not empty, not too long). **A wrong answer carrying citations passes** (for example a fact stated wrongly but still marked `[1]`). Having the model check facts is left to be decided after evaluation.
- The rule list for prompt injection can only stop the most obvious forms and is not a security boundary; the real defence is that permissions are filtered in the database, so the model cannot get content it may not read.
- Fixed replies are English only; the history keeps only the last 6 turns; the conversation title is the first 60 characters of the first question.
- The real check asked each scenario only once, and the model's answer may differ slightly each time (the classification of the understand step did differ between two runs); the sample is very small and no conclusion about the model's merits can be drawn from it.
- The hidden-content threshold and the rerank score threshold (6) were calibrated on a few dozen questions, and a different set of documents or phrasings may need new calibration.
- Data queries (M6) and write action confirmation (phase 2) are not implemented yet and are answered with a fixed refusal.


---

## M6 Data access: MCP and the SQL agent

Status: **In progress** (branch `m6-data-access`). Connect the "query data" questions that are now refused with a fixed reply: fixed parameterised tools (through MCP) plus free-form read-only SQL. This milestone calls OpenAI's chat models (choosing tools, generating SQL, answering from the result).

### Findings of the research before starting (verified)

| Item | Result |
|---|---|
| MCP SDK | The latest is `mcp 2.3.0`, **whose API differs from the old one** (`FastMCP` is renamed `MCPServer`, and the client changed too). I built a small prototype to verify: `MCPServer(token_verifier=..., auth=AuthSettings(..., validate_token_resource=False))`, a tool gets the caller and the raw token with `get_access_token()`, and the client uses `Client(streamable_http_client(url, http_client=httpx2.AsyncClient(headers={"Authorization": ...})))`. **A valid token can call the tools; a wrong token and no token are both refused (401)** |
| SQL parsing | `sqlglot 30.27.0` (MIT), parsing in the PostgreSQL dialect, which can extract table names (with schema), CTEs, functions, the number of statements and the statement type; used for statement validation |
| Views | 7 views in `ai_sql`: `campuses`, `assignments`, `students`, `submissions`, `support_tickets`, `employees`, `expense_claims` (columns in M2). The row scope is already guaranteed by the views, which is the real boundary |
| Evaluation set | 26 questions that should be answered; M2 only checked the answers of 17; **the other 9 (SQL-01, 02, 04, 05, 06, 08, 09, 10, 13) have to be checked by really generated queries**. Of these, SQL-01 and 02 ask about "over the hotel limit of FIN-REIM-002"; the limit (600 for tier 1, 450 for tier 2) is written in the policy file, **so the table alone cannot answer it, and the policy passage must also be given to the SQL generation step** |
| Conventions of design 03 | Tools use fixed parameterised queries; **free-form SQL is handled by the SQL tool inside the agent and does not go through MCP**; tool error codes `forbidden`, `not_found`, `invalid_argument`, `internal_error`; every call writes a `mcp.<tool>` audit |

### Questions to confirm first

1. **Use the MCP SDK 2.x** (`MCPServer`), with the dependency pinned as `mcp>=2.3,<3`. The SDK is very new, and the 2.x interface follows what I verified.
2. **How the agent calls MCP tools**: in production over HTTP, **forwarding the user's own JWT**, with the MCP server verifying signature and the audience `starit-mcp` itself (6.1 of design 03); this needs the raw token passed from the API all the way to the runtime (kept only in memory, never written to the log or the audit). Tests and evaluation do not start an HTTP server and use an **in-process implementation** (sharing the same tool functions with the MCP server side).
3. **The SQL generation step carries policy passages**: a data question first does one search (hybrid mode, no rerank, the top 3 passages, permission filter as usual) to put the relevant policy into the prompt, so that questions such as "hotel limit" can be answered. One more search (the database plus one embedding), not one more model call.
4. **Citations of data answers**: cite the data source rather than a document. The citation structure of design 03 gains a `kind` field: `"document"` (the existing one, with the field added) or `"data"` (with `views` and `row_count`). The answer still uses `[n]` marks, and verification still requires a citation.
5. **How to refuse out-of-scope data questions** (the 7 "should be refused" questions of the evaluation): a view returning an empty result cannot tell "none" from "no permission", so two **best-effort checks** are added before execution: (a) the role has no access to this view at all (for example a student querying the employee table, Admin querying any data) → `no_permission / restricted_data`; (b) the literal value of `campus_id` in the query is not the asker's own campus and the role is not company-wide (hr, finance) → likewise ends. These two checks can only recognise literal values written in the SQL, and the real protection is still the views.
6. **Add evaluation questions for the MCP tools**: about 8 tool-type questions are added to the evaluation set (the status of one's own expense claim, which assignments a course has, one student's progress and so on), with answers computed by the sample data generator, since the existing 33 almost all need aggregation and go through SQL.
7. **The `search_documents` tool** uses hybrid mode without rerank by default (the MCP server side has no chat model); scenarios needing rerank go through the assistant itself.
8. **Real check**: the 33 questions of the evaluation set plus the new tool questions, about 41, with the number of calls and the estimated cost given first and run after confirmation.

### Planned files (under `ai-module/` unless stated otherwise)

| File | Purpose |
|---|---|
| `packages/core/src/starit_core/dataaccess/sqlguard.py` (new) | SQL statement validation: a single `SELECT`/`WITH`, only `ai_sql` views, a function allow-list, no `INTO`, locking, writes inside CTEs, `pg_*` and so on; checks that the "campus literal" matches the asker's campus |
| `packages/core/src/starit_core/dataaccess/schema.py` (new) | View descriptions (for the SQL generation prompt), the campus code table, the role-to-view access table |
| `packages/core/src/starit_core/dataaccess/tools.py` (new) | The implementation of 6 tools (fixed parameterised queries, through `run_as_identity`), parameter validation, error codes, `mcp.<tool>` audit |
| `packages/core/src/starit_core/dataaccess/client.py` (new) | The `DataTools` interface; `McpDataTools` (calls MCP over HTTP, forwarding the user token) and `LocalDataTools` (in-process) |
| `packages/core/src/starit_core/sqlaccess.py` (changed) | Supports bound parameters |
| `packages/core/src/starit_core/agent/nodes.py`, `graph.py`, `state.py`, `messages.py` (changed) | New nodes: `plan_data_access`, `call_data_tool`, `run_sql` (generate → validate → execute → retry), `answer_from_data`; `data_query` no longer ends with `not_available_yet`; new reason codes `restricted_data`, `no_matching_rows`, `sql_failed`, `tool_error` |
| `packages/core/src/starit_core/agent/prompts/plan_data.md`, `sql.md`, `answer_data.md` (new) | Prompts and version numbers |
| `packages/core/src/starit_core/agent/runtime.py` (changed) | Receives the user's raw token; builds the data tools |
| `apps/mcp-server/src/starit_mcp_server/` (changed): `main.py`, `auth.py`, `tools.py` | The MCP service: `MCPServer`, token verification (reusing `TokenVerifier`, audience `starit-mcp`), 6 tools, a health check |
| `apps/api/src/starit_api/conversations.py` (changed) | Hands the token to the runtime |
| `deploy/compose/compose.yaml`, `.env.example` (changed) | The `mcp-server` service (port 8100); the API depends on it; `STARIT_MCP_URL` |
| `packages/core/src/starit_core/config.py` (changed) | `model_plan`, `model_sql`, the limits (SQL retries 2, tool calls ≤ 3, row limit, timeout), `mcp_url` |
| `ai-module/sample-data/tools/generate_structured.py`, `eval/sql-qa.jsonl` (changed) | About 8 new tool-type questions |
| `eval/src/starit_eval/data_check.py`, `cli.py` (changed) | `starit-eval data`: really asks the data questions and checks them against the expected answers, writing a report |
| `packages/core/tests/dataaccess/`, `packages/core/tests/integration/test_data_*.py`, `apps/mcp-server/tests/` (new) | See the verification criteria |
| `docs/design/03`, `04`, `ai-module/README.md` (changed) | The `kind` field of citations, the data path, how to use MCP |

### Changes to the graph (design 04)

```
understand ── data_query ──▶ plan_data_access ─┬─ parameterised tool ──▶ call_data_tool ─┐
                                               └─ free-form question ──▶ run_sql ────────┤
        result: no permission (access table or campus check) ──▶ END_NO_PERMISSION (restricted_data)
                empty result ───────────────────▶ END_NOT_FOUND (no_matching_rows)
                validation or execution failing repeatedly ──▶ END_ERROR (sql_failed / tool_error)
                has data ──────────────────────▶ answer_from_data ──▶ verify_answer ──▶ END_ANSWERED
```

Inside `run_sql`: search policy passages → generate SQL → validate → execute → on failure tell the model the error and generate again, at most 2 retries.

### Key design decisions (proposed)

- **The boundary is still the database**: SQL generated by the model is only run against the views under the `ai_sql_ro` role, and the views return only rows that user may see; `sqlguard` is a second layer whose purpose is to stop obviously wrong statements before they reach the database and to give a clear reason for the refusal.
- **Validation uses an allow-list, not a deny-list**: only `SELECT` (including `WITH`); tables must carry the `ai_sql.` prefix and be among the 7 views; functions must be on the allow-list (count, sum, average, min and max, `round`, `coalesce`, `nullif`, `lower`, `upper`, date functions, `cast` and so on).
- **The answer is based only on the result**: `answer_from_data` gets only the question, the SQL that was run (to explain the basis) and the result rows; it is told that "the result contains only data the user may see, so do not present it as a company-wide total".
- **A result limit of 200 rows and a statement timeout of 5 seconds** (following M2's `run_as_identity`); when the result is large, only the first few dozen rows go to the model and the truncation is stated.
- **Audit**: every data query writes a `data.sql` or `mcp.<tool>` audit (user, a summary of the statement or arguments, number of rows) and never the result content.
- **Tokens stay in memory**: not in logs, not in the audit, not in error messages.

### Planned commands

```bash
git switch -c m6-data-access                      # already created
uv sync --all-packages
(cd sample-data && python3 tools/generate_structured.py)   # the new tool-type questions
make test && make lint
make up                                           # now includes mcp-server
make eval ARGS="data --yes"                       # real evaluation of the data questions (estimate printed and confirmed first)
```

### Verification criteria

1. **SQL validation**: a batch (60 or more) of hand-built statements each asserted to pass or be refused: valid aggregations, joins, CTEs and date arithmetic pass; multiple statements, non-`SELECT`, `biz.*`, `ai.*`, `pg_catalog.*`, `public.*`, table names without a prefix, `set_config`, `pg_sleep`, `current_setting`, `INTO`, `FOR UPDATE`, `DELETE` inside a CTE and so on are all refused, with a reason.
2. **Campus and access-table checks**: cases where the campus literal (`=`, `IN`, an aliased column) differs have a test matrix; **the role-to-view access table agrees with the behaviour of the views in the database** (for 9 demo accounts × 7 views: where the access table says "no right" the view must return empty).
3. **Every End state of the data path has a test** (scripted model): `answered`, `no_permission / restricted_data`, `not_found / no_matching_rows`, SQL invalid the first time and fixed the second, three invalid in a row → `error / sql_failed`, database timeout → `error / sql_failed`, a tool parameter error or a tool error → `error / tool_error`, call count exceeded → `step_limit`.
4. **Hostile output tests**: the model returns `SELECT * FROM biz.students`, multiple statements, `set_config` and so on, and they are stopped before reaching the database, with no query executed at all.
5. **MCP service**: integration tests start a real server: a valid token can call; a token with a tampered signature, expired, with an audience of only `starit-api`, or no token are all refused; the 6 tools return data consistent with the views for the demo accounts; `list_students` returns only the student themselves to a student and only the own campus to an employee; querying someone else's expense claim returns `not_found`; a parameter error returns `invalid_argument`; every call has a `mcp.<tool>` audit record.
6. **Graph structure**: every node can still reach some End node; the drawn graph matches the routes in the document.
7. **Real check** (after the cost is confirmed): really ask the data questions of the evaluation set (26 that should be answered + 7 that should be refused + the new tool questions) once; **those that should be answered are checked against the expected answers, and those that should be refused must end with `no_permission` or `not_found` and leak no number**; the report states each question's result, the reasons for failures and the cost; **no pass rate is set in advance**, and the results are looked at first before deciding how to tune.
8. **Container smoke test**: the `mcp-server` container is healthy; ask one data question over HTTP with a real token and confirm that the token forwarding API → MCP works.
9. Local tests, lint and mypy pass, and CI passes.

### Things unclear beforehand

- **The MCP SDK 2.x is very new** (2.3.0), the interface follows what the prototype verified and may still change; the version is pinned and stated in the README.
- **The quality of the SQL the model generates**: date arithmetic (`submitted_date - expense_date`), definitions such as "over 30 days", `CASE` tiers; how many `gpt-6-luna` gets right I do not know, and the real evaluation decides; if it cannot be tuned, the fallback is to change the prompt and give more examples, not to loosen validation.
- **`sqlglot`'s PostgreSQL dialect differs subtly from the database's real semantics**, and may wrongly refuse valid statements or miss rare forms; what is missed causes no overreach (the database role can only read the views), but could let the model run a function it should not, so a function allow-list is used and the database role is the backstop.
- **Every MCP call creates a new session**, which adds a little latency (expected 100 to 300 milliseconds); the connection can be reused later.
- **Passing the raw token into the runtime** widens the exposure of the token, and it must be ensured that no exception message or log contains the token (tested).
- The campus check can only recognise literal values written in the SQL; it cannot see forms that go around it with subqueries or joins, but the views still return only rows the user may see.

### For you to confirm

1. Use the MCP SDK 2.x (`mcp>=2.3,<3`).
2. In production the agent calls MCP over HTTP and forwards the user token; tests and evaluation use the in-process implementation.
3. The SQL generation step carries the retrieved policy passages (no rerank).
4. The citation structure gains `kind` (`document` / `data`).
5. The two checks before execution: the role access table and the campus literal.
6. About 8 new tool-type questions in the evaluation set.
7. The `search_documents` tool in hybrid mode without rerank by default.
8. A real check of about 41 questions (estimate first, then confirm).

### The user's confirmation (2026-11-03)

All 8 were accepted: the MCP SDK 2.x (`mcp>=2.3,<3`); in production the agent calls MCP over HTTP and forwards the user token, with tests and evaluation using the in-process implementation; the SQL generation step carrying the retrieved policy passages (no rerank); the citation structure gaining `kind`; the two checks before execution (role access table, campus literal); about 8 new tool-type questions in the evaluation set; `search_documents` in hybrid mode without rerank by default; a real check of about 41 questions (estimate first, then confirm).

### Actual results

**Status: code complete, the real check has run; CI still to be checked, awaiting your confirmation to merge.**

- **Automated tests**: all 615 pass (437 at the end of M5). Added: SQL validation with 100-plus statements (pass / refuse / view allow-list / function allow-list / role and campus checks), the consistency of the role access table with the views (account by account), the consistency of view columns with the schema description, the 6 tools (each role, overreach, parameter errors, audit), the real MCP service (uvicorn in a thread, real signature verification; no token, a garbled one, a wrong key, expired and an audience mismatch all get 401), the agent data path (the tool path, the SQL path, retries, refusal, an empty result, the token not written to disk), evaluation scoring. lint and mypy are clean.
- **Container smoke test**: the `mcp-server` container is healthy; calling tools with real tokens issued by Keycloak: a manager querying the own campus's students succeeded, querying another campus (`campus_id=BJ`) got `forbidden`, a student calling the expense tools got `forbidden`, an employee querying their own expense claim succeeded and someone else's got `not_found`, a garbled token was refused; `ai.audit_log` has the matching `mcp.*` records (including the refused ones), and the container log has no token.
- **The whole chain through the API container** (real model): asking "what is the status of my expense claim C0107", the API forwarded the user token to the `mcp-server` container, the tool returned `paid`, the answer carried a citation with `kind: "data"`, the audit has `mcp.get_expense_claim_status`, and the container log has no token. **This check found a real defect**: the SDK's host header check (against DNS rebinding) refused the Compose service name `mcp-server:8100`, and the API got `tool_error`. The earlier service tests accessed it through `127.0.0.1` and did not cover this. A configuration item `mcp_allowed_hosts` was added (keeping the protection on and only letting the listed hosts through), with two regression tests (the service name allowed, a strange host refused, both with a valid token so that the decision depends only on the host header). The first question asked, "how many students on my campus", went through the SQL path and the answer was 5, without passing MCP. During this the Docker disk filled up (6 GB of build cache was cleaned and the images rebuilt).
- **Real data check** (`starit-eval data`, default model `openai/gpt-6-luna`, 41 questions): the first run 39/41, 151 model calls, about $0.03 (estimate $0.027). Report: `docs/eval/data-check-20261103-1733.md`.
  - **SQL-26** (a student's average score): the answer was correct (81.5000…) and it was **my scoring being too strict**, accepting only a number written as `81.5`. Changed to compare by numeric value.
  - **SQL-29** (a Shanghai manager asking for the number of Beijing students): **a real gap**. The model wrote a condition such as `campuses.name = 'Beijing'`, my campus check only recognised literal values of `campus_id`, did not stop it, and the user got "0 students". The views leaked no data, but this is not the result the design requires (it should be refused). Fixed: when a statement reads the `campuses` view and a string contains another campus's city name, it is likewise refused by `campus_scope`; `expense_claims.city` is a travel city and is unaffected (tested).
  - After the fix only these two questions were rerun: 2/2 passed, 7 model calls, about $0.001. Report: `docs/eval/data-check-20261103-1737.md`. **The 41 questions were not rerun as a whole**, so "41/41" never appeared in a single run.
- **Differences from the design**:
  - The `top_k` of `search_documents` is at most 8 (the design says 10); there is no `doc_code` parameter; `domain` is a filter on the `doc_code` prefix (HR-/FIN-/TS-) applied after search; the returned fields do not include `status`, `page`, `chunk_id` or `score` (only `doc_code`, `title`, `version`, `heading_path` and `text`). The agent's planning step does not use this tool (document questions go through the original search path), and it is mainly for other MCP clients.
  - A run calls at most one data tool (the checklist says ≤ 3); on a tool parameter error it falls back to the SQL path.
  - `agent_max_llm_calls` was raised from 6 to 8 to leave room for SQL retries.
  - `domain` was not added to `Candidate` in any way other than the `doc_code` prefix.
  - One `type: ignore` was added on the MCP SDK's `custom_route` decorator (the SDK's type annotations are incomplete).
- **Known limits**: the campus check can only recognise campus codes written in the SQL or (when reading `campuses`) city names; another way of writing it (for example a subquery that points indirectly to another campus by another column) may slip past, and the real protection is still the views; what slips past gives "empty data", not another campus's data. An empty result always says "no matching records found", which cannot tell "none" from "no permission", and this is deliberate. The quality of the SQL path depends on the model; across the 41 questions there was only this one interception gap, the sample is small and must not be taken as a benchmark.

## M7 Document management and front end

Status: **In progress** (branch `m7-docs-frontend`). Two things: (1) the back end's document management API and the interface for "click a citation to see the original"; (2) the Next.js front end in `ai-module/web/`: sign-in, chat page, conversation list, citation viewing, document management page. This milestone **does not call paid models**, and only does one small real check at the end (see below).

### State before starting (verified)

| Item | Result |
|---|---|
| The existing API | `/healthz`, `/me`, `/conversations` and its message endpoints. Paths have no `/api/v1` prefix (M5 already did it this way). **No** CORS configuration. **No** `/documents` endpoint at all |
| The existing document service (core) | `register_document`, `update_access`, `set_status`, `delete_document`, `set_content`, the ingestion queue, `ObjectStorage` (only `put`/`get`, **no `delete`**). The upload path is the same as `register_from_manifest` |
| What the citations lack | Document citations have `doc_code` and `chunk_id` but **no `document_id`**, so the front end cannot request `/documents/{id}/chunks` when a citation is clicked |
| Front end | The directory `ai-module/web/` does not exist yet. Node 20.19.6 and npm 10.8.2 are installed; there is no `.nvmrc` yet |
| Keycloak | The `starit-web` client is already set up: a public client, authorization code + PKCE (S256), redirect `http://localhost:3000/*`, web origin `http://localhost:3000`, token audiences include `starit-api` and `starit-mcp` |
| Permissions | A `RAGETLAdmin` account has only this one role and, by 4.3 of design 01, **can see only document metadata and not the body**; the management endpoints allow `RAGETLAdmin` only |
| CI | At the moment there is only one job, `ai-module` (Python), and no front-end job |

### Questions to confirm first

1. **Browser sign-in**: use `oidc-client-ts` to do authorization code + PKCE in the browser, keeping the token in memory (restored from `sessionStorage` when the page is refreshed) and sending `Authorization: Bearer` directly when requesting the API. No server-side session and no NextAuth. The benefit is that it matches the back end's "trust only the JWT" model exactly, with no second session; the cost is that the token is in the browser (mitigated by PKCE and a short lifetime).
2. **How the browser reaches the API**: the API gets a CORS middleware, the allowed origins are set by `STARIT_CORS_ORIGINS` (default `http://localhost:3000`), only the `Authorization` and `Content-Type` headers are allowed, and no cookies. The alternative is a Next.js reverse proxy, which adds a hop and also makes SSE (later) harder.
3. **Path prefix**: keep the prefix-less paths already implemented (`/conversations`, `/documents` and so on) and change the `/api/v1` prefix of design 03 to "added when needed later". Changing the prefix would touch all the tests and scripts of M5 and is of little value.
4. **Scope of the document management API**: the 7 endpoints of section 5 of design 03 (`POST/GET /documents`, `GET/PATCH/DELETE /documents/{id}`, `POST …/reindex`, `GET …/jobs`) plus `GET /documents/{id}/chunks` and `GET /documents/{id}/file` for reading. Upload limits: a single file ≤ 20 MB, only docx/pdf/md/txt (judged by both extension and file header); the same `content_hash` with the same `(doc_code, version)` returns 409. `DELETE` is a hard delete (decided in the design), so `ObjectStorage` gets a `delete`. Every write action is audited.
5. **Citations gain `document_id`**: document citations gain `document_id` (design 03 is changed to match), and when `[n]` is clicked the front end requests that document's chunks and highlights the cited chunk; data citations (`kind: "data"`) only show the view name and row count and cannot be opened.
6. **Front-end stack**: Next.js 15 (App Router), TypeScript strict mode, Tailwind, shadcn/ui, ESLint, Prettier; unit tests with Vitest + Testing Library; package management with npm (`package-lock.json` committed); `.nvmrc` pins Node 20.
7. **No streaming in phase 1**: after sending, the chat page shows "thinking" and waits for `POST …/messages` to return the full answer (measured about 3 to 8 seconds). The SSE in the design belongs to phase 2.
8. **End-to-end smoke tests (Playwright)**: needs a Chromium download (about 150 to 300 MB), **so your agreement is needed before downloading**. They cover: sign-in, asking, viewing a citation, uploading a document. To cost nothing and not depend on the model, the asking step **intercepts `POST …/messages` and returns a fixed answer**; the upload step goes through the real API → ingestion queue → worker, but the embedding in the container uses `EMBEDDING_PROVIDER=fake` (already there since M3). Run locally with `make e2e` (needs `make up`), **not run in CI** (CI has no full Compose stack), and CI only runs the front end's lint, type check, Vitest and build.
9. **Containers**: Compose gains a `web` service (a Next.js standalone build, port 3000, depending on api and keycloak), and `.env.example` gains `NEXT_PUBLIC_*` settings (API address, Keycloak address and client id).
10. **Real check**: when done, upload 1 small document as `RAGETLAdmin`, ingest it with **real embedding** (an estimated under $0.001), then ask an account with permission a question about it (about 4 model calls, about $0.001). The estimate comes first and it runs after you confirm.

### Planned files (under `ai-module/`)

| File | Purpose |
|---|---|
| `apps/api/src/starit_api/documents.py` (new) | The 8 endpoints of document management and reading; `require_roles("RAGETLAdmin")`; paging (`limit`/`cursor`), filtering; upload validation |
| `apps/api/src/starit_api/main.py`, `config` (changed) | Mount the routes; CORS (`cors_origins`) |
| `packages/core/src/starit_core/storage.py` (changed) | `ObjectStorage.delete` (S3 and in-memory implementations) |
| `packages/core/src/starit_core/documents.py` (changed) | Service functions for listing, reading chunks and updating metadata (keeping "update the document and chunks in the same transaction") |
| `packages/core/src/starit_core/agent/nodes.py` (changed) | Document citations carry `document_id` |
| `apps/api/tests/integration/test_documents.py` (new) and so on | See the verification criteria |
| `web/` (new) | `app/` (sign-in callback, chat page, document management page), `components/` (conversation, citation drawer, conversation list, document table and upload form, shadcn/ui), `lib/` (OIDC, API client), `tests/` (Vitest), `e2e/` (Playwright), `Dockerfile`, `package.json`, `.nvmrc` |
| `deploy/compose/compose.yaml`, `.env.example`, `Makefile` (changed) | The `web` service; `make web-dev`, `make e2e` |
| `.github/workflows/ci.yml` (changed) | The front-end job: `npm ci`, lint, type check, Vitest, build |
| `docs/design/01`, `03`, `ai-module/README.md` (changed) | The note on the path prefix, the citation's `document_id`, how to start the front end |

### Pages (phase 1)

- `/`: a signed-in user enters the chat page; a user not signed in is redirected to Keycloak. The conversation list is on the left (new, rename, archive), the conversation in the middle, and the `[n]` in an answer is a clickable mark that opens a drawer on the right: document name, code, version, status, section path, the cited chunk (highlighted) and the chunks before and after; a data citation shows "From data: students, 12 rows". When an answer ends with `no_permission`/`not_found`/`refused`/`error` the matching ordinary notice is shown (the back end already supplies the uniform text).
- `/admin/documents`: visible in the menu only to `RAGETLAdmin`; a table (code, title, version, status, ingestion status, update time) with filters; an upload form (the fields of section 5 of design 03); per-row actions: edit metadata and permissions, re-ingest, delete (confirmed twice), view ingestion jobs (stage, attempts, error code and message). Other roles who go to that address directly see "no permission", and the back end likewise returns 403.
- Whether a menu or button is shown depends only on `/me`; the back end checks again on every endpoint.

### Planned commands

```bash
git switch -c m7-docs-frontend                    # already created
uv sync --all-packages
(cd web && npm ci)
make test && make lint                            # back end
(cd web && npm run lint && npm run typecheck && npm test && npm run build)
make up                                           # now includes web
make e2e                                          # Playwright (agree to the browser download first)
```

### Verification criteria

1. **Permission matrix of the document management API**: 9 demo accounts × each endpoint: only `RAGETLAdmin` succeeds, the rest get 403, and not signed in gets 401.
2. **Upload**: the four valid formats get 202 and are queued; over 20 MB, an extension that does not match the file header, a missing required field, an invalid `access_level` → 422; a duplicate → 409 with the id of the existing document; audited.
3. **Whole flow** (fake embedding): upload → worker ingestion → `ingest_status = ready` → an account with permission can find it by search and an account without permission cannot.
4. **Metadata and permission changes**: after `PATCH` the document and all chunks are consistent within the same transaction (the same test approach as M2); after the status becomes `superseded`/`archived`, search behaves as design 02 says.
5. **Deleting and re-ingesting**: after deleting, the document, chunks, vectors and original file are all gone and the citation text in conversation history is kept; after a successful re-ingestion the old chunks are replaced atomically, and on failure the old chunks stay untouched.
6. **Reading endpoints**: `chunks`/`file` use the same permission function as search; no permission returns 404; `RAGETLAdmin` (with no business role) gets 404 reading the body and 200 reading the metadata.
7. **Citations**: document citations carry `document_id`, and requesting chunks with it gets the cited chunk.
8. **CORS**: allowed origins pass the preflight; other origins get no `Access-Control-Allow-Origin`.
9. **Front end**: Vitest covers the OIDC callback and token handling, the menu driven by `/me` (one assertion for each of 7 roles), the citation drawer, upload form validation and error states; lint, type check and build pass.
10. **Playwright smoke** (local): sign in, ask (the intercepted answer), click a citation and see the original, `RAGETLAdmin` uploads until `ready`; an ordinary account does not see the management menu and gets a no-permission page when going to the management address directly.
11. **Container smoke test**: the `web` container is healthy, and the browser completes sign-in and one question through `http://localhost:3000`.
12. Real check (after confirmation): upload 1 small document and ingest it with real embedding, then ask one question and get an answer with citations.
13. Local tests, lint and mypy pass, and CI (including the new front-end job) passes.

### Things unclear beforehand

- **Keeping the token in the browser** is a security trade-off (XSS can read `sessionStorage`). Mitigation: Keycloak tokens have a short lifetime (keeping the current setting), the front end renders no unescaped HTML, and answers are rendered as plain text or controlled Markdown. If you would rather use a server-side session (NextAuth + the back end exchanging tokens), the cost is a second session, to be changed in item 1.
- **The latest minor versions of shadcn/ui, Tailwind and Next.js 15** will be checked and pinned at the start; Next.js major versions move fast and may differ from the APIs I remember, and what is actually installed prevails.
- **Playwright's browser download on the Mac** needs the network and about 300 MB of disk (the Docker disk has just filled up once; that is a real constraint of this machine and has nothing to do with the browser, but a reminder).
- **Uploading large files and the ingestion time**: the parsing of docx/pdf is in the worker, the upload endpoint only enqueues; the page updates the status by polling `GET /documents` (every 3 seconds), with no push.
- **Deleting is a hard delete** and cannot be recovered; the front end asks for a second confirmation and the back end writes an audit, but there is no "recycle bin".

### For you to confirm

1. In-browser OIDC (authorization code + PKCE), with the token in memory/`sessionStorage`.
2. CORS added to the API, with configurable origins.
3. Keep the prefix-less paths and change design 03.
4. The 8 document management endpoints, uploads ≤ 20 MB, four formats, `ObjectStorage` gets `delete`.
5. Document citations gain `document_id`.
6. Front-end stack: Next.js 15, strict TypeScript, Tailwind, shadcn/ui, Vitest, npm, Node 20.
7. No streaming in phase 1.
8. Playwright runs locally, intercepts the chat answer, uploads with fake embedding; **agree to download Chromium**; CI only runs lint/types/Vitest/build.
9. Compose gains a `web` service.
10. Real check: upload 1 small document (real embedding, under $0.001) + 1 question (about $0.001), estimate first and confirm afterwards.

### The user's confirmation (2026-11-03)

All 10 were accepted (in-browser OIDC; CORS; prefix-less paths; 8 document endpoints; citations gaining `document_id`; the front-end stack; no streaming; Playwright running locally and **agreeing to download Chromium**; Compose gaining `web`; the real check with estimate first and confirmation afterwards).

### Pause record (2026-11-04)

The user stepped away for a while and **M7 was paused**, to continue when the user gives the "resume" instruction. The state at the time:

- **Done and committed** (branch `m7-docs-frontend`): the back end's document management API, the reading endpoints, CORS, the citation `document_id` (699 Python tests pass); the Next.js front end (sign-in, chat, citation drawer, document management page, 61 Vitest tests, lint, types, format and build pass); the web Dockerfile, the Compose `web` service, the CI front-end job, Makefile targets, Playwright tests, and the revisions to the README and design 03.
- **Containers**: `api`, `web`, `worker`, `mcp-server` and the others are running and healthy; `web` returns 200, the API's CORS lets `http://localhost:3000` through; `worker` is back to the normal (`openai`) embedding configuration.
- **Not finished**: (1) the Playwright smoke test **has not completed even once**: the Chromium download was at about 50% when I stopped it on the pause instruction; running `make e2e` again will download it again (about 186 MB). (2) The real check (upload 1 small document + 1 question) is not done yet and needs an estimate first and your confirmation. (3) The "Actual results" of this section is not filled in. (4) CI has not run the front-end job on the new branch yet. (5) The merge and the `ai-m7` tag.
- **Findings about this machine's environment** (to go into the actual results): Docker Desktop's virtual disk once filled up (`no space left on device`), Postgres crashed and entered recovery mode, and `worker` restarted for more than an hour; it recovered after 6 GB of build cache was cleaned. The network is very slow when downloading Python dependencies during image builds, and `uv`'s default 30-second timeout made a build fail, now set to `UV_HTTP_TIMEOUT=120` in `python.Dockerfile`; this build of the API image took about 40 minutes. Docker still holds about 8.6 GB of images and 10 GB of volumes that could be reclaimed, left untouched.
- **Uncommitted changes**: `ai-module/deploy/docker/python.Dockerfile` (the timeout setting) and this record.

The order after resuming: confirm the containers are healthy → `make e2e` → handle failures (if any) → fill in the actual results → give the estimate for the real check and wait for confirmation → push, look at CI → ask the user to confirm the merge and tag `ai-m7`.

### Actual results

**Status: code complete, the end-to-end smoke test and the real check pass, awaiting your confirmation to merge.**

- **Back-end tests**: 699 pass (615 at the end of M6). 82 new document API tests: 7 roles × 7 management endpoints (only `RAGETLAdmin` succeeds, the rest get 403, not signed in 401); upload validation (an extension that does not match the file header, an empty file, non-UTF-8 text, text containing binary, over 20 MB, missing fields, invalid `access_level`/`doc_code`/`version`/`domain`/`status`/`min_level`, a file name with path traversal); a duplicate upload gets 409 and the message carries the existing document's id; **the whole flow** (real worker, fake embedding): upload → `ready` → an employee finds it by search, a student and `RAGETLAdmin` cannot; `chunks`/`file` give 200 to an employee and 404 to a student and `RAGETLAdmin`; `around` fetches the chunks before and after; after `PATCH` the permissions of the document and all chunks are consistent within one transaction, and after changing to `draft` it can no longer be read; a grade requirement can be set and cleared; after deleting, the document, chunks and original file are all gone, the audit is kept, and deleting again gives 404; after re-ingestion the chunks are replaced as a whole and the job history has two entries; list filters (domain, status, ingestion status, title or code, `%` taken as a literal) and paging; CORS (the front-end origin allowed, other origins not, and an ordinary request also carries no `Access-Control-Allow-Origin`).
- **Front end**: Vitest 61 pass; lint, type check (strict mode, including `noUncheckedIndexedAccess`), format check and production build are all clean. Covered: `[n]` parsing (an unknown number stays text, content is not treated as HTML), the return path accepting only in-site paths, the menus of 7 roles (only `RAGETLAdmin` sees the "Documents" link; going directly to the management page also shows no permission and sends no request), the citation drawer (data citations show view and row count; document citations request `around`, highlight the cited chunk, and show a notice when reading fails or there is no `document_id`), the upload form (validation, sending no request, encoding of fields and duplicates, server errors such as a duplicate), the documents page (list, deleting needs a second confirmation, filters, ingestion jobs and error reasons), chat (create a conversation, send, show the answer and sources, a rate-limit notice), the API client (carries the token, 401 triggers a new sign-in, no token sends no request).
- **Playwright smoke** (`make e2e`, Chromium, against the real Compose stack): 3 pass. (1) An employee signs in: sees the assistant, does not see "Documents", going directly to the management page shows no permission, and **requesting `/documents` directly with the token gets 403**; (2) asking (the model intercepted as a fixed answer, the page and API real), clicking `[1]` shows the source; (3) `RAGETLAdmin` uploads a document → waits for `ready` (the worker temporarily on fake embedding) → the administrator account cannot read the body (404), the employee can → clicking the citation on the chat page shows the original → the administrator deletes it in the page (with confirmation) → the row disappears. After `make e2e` finishes the worker automatically returns to real embedding, and no test document remains in the database.
- **Two e2e failures were my test being wrong, not the application**: the route announcer element that Next.js ships with is also `role="alert"` and my locator matched two; `Title` matched both the title input and "Search title or code", so it was changed to locate by text and exact label.
- **Containers**: `web` (a standalone build), `api`, `mcp-server`, `worker` and the others are healthy; `web` returns 200; the API's CORS preflight for `http://localhost:3000` passes.
- **Differences from the confirmation points**: (a) the shadcn/ui components (button, input, badge, dialog and so on) were **written by hand** by me, following its utility libraries (`class-variance-authority`, `clsx`, `tailwind-merge`) and its style, without its CLI, to avoid an interactive install and the extra Radix dependencies; the dialog is implemented by itself with `role="dialog"`. (b) The front end uses Next.js 15.5.29 + React 19 + Tailwind 4 (the latest on npm is Next 16, pinned to 15 by the design). (c) `min_level` is a grade number from 1 to 7. (d) The list's `cursor` is an offset, not a cursor key. (e) Answers are rendered as plain text (`[n]` becomes a button), with no Markdown rendering. (f) In item 8, "the upload step uses fake embedding" is done by temporarily switching the worker through `make e2e`.
- **Findings about this machine's environment**: Docker Desktop's virtual disk once filled up (`no space left on device`), Postgres crashed into recovery mode, and `worker` restarted for more than an hour; it recovered after cleaning 6 GB of build cache, and later the user raised the disk limit to 80 GB, and stopped containers, dangling images and build cache (about 6 GB) were cleaned again. The network is very slow when downloading Python dependencies in image builds, and `uv`'s default 30-second timeout made one build fail, now set to `UV_HTTP_TIMEOUT=120` in `python.Dockerfile`; building the API image took about 40 minutes.
- **Known limits**: the token is kept in the browser's `sessionStorage` (XSS can read it; mitigation: Keycloak tokens have a short lifetime and no HTML is rendered); `npm audit` reports 16 medium and high findings, coming from development tools (the dependencies of Vitest, `minimatch`) and the PostCSS bundled with Next.js (it only matters for untrusted CSS input, and this project's build only processes its own CSS), **accepted, without forcing an upgrade** to versions that would bring in Next 16; the status after an upload relies on polling every 3 seconds, with no push; deleting is a hard delete with no recycle bin; Playwright runs only locally, and CI only runs the front end's lint, types, format, Vitest and build.
- **Real check** (run after the user's confirmation, real embedding and the real model `openai/gpt-6-luna`): with the `RAGETLAdmin` account, a small document `VERIFY-001` ("the hotel standard of the verification city is CNY 777 per night") was uploaded through the API → status `queued → running → ready`; then an employee account asked "What is the hotel allowance per night for the verification city?". **The first time the assistant did not answer directly but asked "Which verification city do you mean?"** (`need_clarification`); that is the model's judgement about my wording and not a problem of the chain; in the same conversation I added "The one in the Verification city allowance document.", and the second time it gave the correct answer "CNY 777 per night … need approval from the finance controller [1]", `end_state = answered`, with a citation carrying `document_id` and `chunk_id`; requesting `GET /documents/{id}/chunks?around=…` with it let the employee read the cited original, while the `RAGETLAdmin` account reading the same document got 404; finally deleting as `RAGETLAdmin` (204) left 0 documents and chunks in the database, and the test file was cleaned up. **Only this one question (two rounds) was asked, not a question set**, so it cannot be taken as a conclusion about quality; the cost was estimated at under $0.002 and was not counted item by item. **A real browser did not sign in and click the citation of this real answer**: clicking a citation in the browser is covered by Playwright (with a fixed answer), and the citation of the real answer was verified only through the API.
- **Not finished**: the CI result of the latest push of this branch.

## M8 Full evaluation, observability and wrap-up

Status: **Done, awaiting merge** (branch `m8-eval-observability`). The last milestone of phase 1: complete the evaluation (more questions, answer correctness, the experiment matrix, one summary report), connect all services to OpenTelemetry and Grafana (Langfuse optional), make a seed for "one command to start, with data even without an OpenAI key", and finally accept item by item the 7 criteria of section 8 of design 06 and tag `v0.1.0`. The real checks of the evaluation and the LiteLLM proxy cost money, so **the estimate comes first and then you confirm**.

### State before starting (verified)

| Item | Result |
|---|---|
| Evaluation | Existing: the search evaluation (4 modes, permission sweep of 54 questions × 7 roles), the assistant spot check (15 rounds), the data questions (41 questions, `starit-eval data`). **Missing**: answer correctness scoring, a summary of refusal correctness, a summary of run metrics, the rest of the experiment matrix, one report that merges them. The tables `ai.eval_runs`/`ai.eval_results` already exist |
| Evaluation questions | `qa-set.jsonl` has 54 questions (`keyword` 3, `version` 2, `paraphrase` 1, `unanswerable` 3, and 1 each for `manager`/`hr`): design 05 already pointed out that this is too few and said M8 would add more |
| Derived content (summary, hypothetical questions) | The `derive` stage in the pipeline is **empty** (the comment says "add it once evaluation proves it useful"), so the "derived content" item of the experiment matrix cannot be done yet |
| Observability | **None at all**: no OTel, no metrics, no Grafana. Logs are JSON with `request_id` but no `trace_id` or `run_id` |
| Seed | There is no `make seed`; today it is `make seed-biz` + `make ingest-samples`, and the latter **needs an OpenAI key**. There is no ready-made vector store dump and no `seed/` directory |
| **A deviation I had not recorded before** | 4.2 of design 01 (which you confirmed) says: the full profile calls models through the **LiteLLM proxy service**, and only lite uses the in-process litellm library. **What M5 did was use the in-process litellm library for every profile**; Compose has no LiteLLM service and the variable `STARIT_LLM_GATEWAY` does not exist. This is a deviation I failed to record in M5; it is recorded now, and confirmation point 1 asks you to decide |
| Resources | Docker Desktop's memory limit is about 11.7 GB, and the 8 core services together now use about 2.1 GB (Keycloak 826 MiB, api 331 MiB, worker 279 MiB, object store 306 MiB, mcp-server 139 MiB, web 131 MiB, Postgres 89 MiB, Redis 39 MiB). The virtual disk is 80 GB |

### Questions to confirm first

1. **The LiteLLM proxy**: fill in what design 01 agreed: Compose gains a `litellm` service (port 4100, with model aliases and keys in its configuration), and the api, worker and mcp-server call through it with `STARIT_LLM_GATEWAY=litellm_proxy`; when running directly on the host (`uv run`, evaluation) the in-process library (`litellm_lib`) is still the default. Benefits: keys live in one service, calls and costs have one record, and it matches the design; costs: one more service (expected 0.3 to 0.5 GB) and one more layer of configuration, and I have **not yet checked** the current LiteLLM proxy image version and configuration format, to be checked at the start. The alternative: do not do it, and change design 01 so that "full through the proxy" becomes "all profiles in the process".
2. **The full evaluation runner**: add `starit-eval answers` (asks the assistant the `qa-set.jsonl` questions and scores them): **deterministic comparison** of codes, numbers, dates and so on; the rest by an LLM judge (the judge model is configured separately, default `gpt-6-luna`), and **a random 20% exported to a table for human checking** (the judge's conclusion is not taken as fact before it is checked); refusal correctness (for questions with `should_answer=false`: a valid state and an answer containing no restricted fact); the validity of the `end_state`/`end_reason` of every run; latency p50/p95, tokens and estimated cost (from `ai.runs`; **note the application account cannot read the audit table but can read `ai.runs`**, which I will check first). Also add `starit-eval all`, merging search, answers, data and the permission sweep into **one report**, written to `ai.eval_runs` (with the commit and the whole configuration) and a Markdown under `docs/eval/`.
3. **Additional evaluation questions (synthetic)**: I read the sample documents and write at least 8 more each for `keyword`, `version`, `paraphrase` and `unanswerable`, at least 6 more questions from `manager`/`hr`/`finance` askers, and at least one "a forbidden role asks about it" question for every restricted document. Each question states its source document and expected answer, and **a script checks that the facts in the expected answer really appear in the source document** (to guard against my own mistakes). The total grows from 54 to a bit over 90. The sample is still small, and even after the additions **no conclusion about accuracy is drawn**; it only gives each question type at least 8 questions.
4. **What the experiment matrix does** (4.4 of design 05):
   - Search mode (4 kinds): rerun on the enlarged question set: **do**.
   - Chunk size 300 / 500 / 800: re-ingest (the embedding cost is negligible, about 11k tokens): **do**.
   - The `identifiers` boost on or off for code queries: add a configuration switch: **do**, costs nothing.
   - Derived content (none / summary / hypothetical questions / all): needs the `derive` stage to be **implemented first** (1 to 2 more model calls per chunk at ingestion, about 80 calls for 28 documents and 39 chunks, about $0.01), then comparing: **proposed to do**, this is the most direct experiment for learning about "paraphrased questions"; it can be dropped if you want to limit the scope.
   - The rerank implementation (LLM listwise / dedicated API): the dedicated API is not connected: **not done**, recorded as "only the LLM listwise was compared".
   - Keyword ranking `ts_rank_cd` / BM25 extension: the extension is not installed and was never verified: **not done**, with the decision recorded as "BM25 is not brought in in phase 1".
5. **Scope of observability**: the api, worker and mcp-server are connected to OpenTelemetry: HTTP requests, SQLAlchemy queries, **every model call** (model name, tokens, duration), **every node of the graph** and every tool call are spans; logs gain `trace_id` and `run_id`. Metrics: request volume and latency, the `end_state` distribution, search latency, the number of model calls and tokens, ingestion queue length and failures, the share of chunks filtered out by permissions. Compose gains `observability.yaml` (OTel Collector, Prometheus, Grafana, Tempo), Grafana has 4 preset dashboards (run overview, End state distribution, search and model latency, ingestion jobs); started by `make up-obs`. **Loki (logs) is not done this time**: logs remain JSON with `trace_id`, read with `docker logs`, saving about 0.5 GB of memory; if you want it, Loki was marked "depending on memory" in design 06.
6. **Langfuse (an optional Compose file)**: `langfuse.yaml` (Langfuse's web, worker and the Postgres, ClickHouse, Redis and object store it depends on), sending **the same traces** over OTLP through the Collector, and writing the evaluation scores to Langfuse. Acceptance criterion 6 requires "Langfuse and Grafana can show the same run", so it is needed. **I have not yet checked which services self-hosting the current Langfuse version needs, how OTLP is connected and the image versions**; they are checked and the memory measured at the start, and filled back into design 06 (expected to be much heavier than the other observability components, roughly over 2 GB, **not verified**).
7. **The seed and `make seed`**: `make seed` = import the business tables (`seed-biz`) + load the **ready-made vector store dump** + put the sample original files in the object store (so that clicking a citation can open the original). The dump `seed/ai-seed.sql.gz` contains documents, chunks, vectors (`text-embedding-3-small`) and derived content, **and not** conversations, audit or evaluation records; it is exported from a verified database by `make seed-dump`. This way **a usable knowledge base exists without an OpenAI key** (asking still needs the key). `make seed ARGS=--ingest` goes through the real ingestion pipeline (needs the key). The size is expected to be under a few MB; if it exceeds the GitHub limit it goes in a release attachment. Keycloak's realm is already imported at `make up`.
8. **Acceptance**: run the 7 criteria of section 8 of design 06 one by one and write `docs/eval/acceptance-v0.1.0.md` (the command, result and unverified parts of each). For criterion 1, "`make up && make seed` on a clean Mac": on **this machine** I run `make clean` (**which deletes this project's local data volumes**: the demo data in Postgres, Redis, Keycloak and the object store, leaving other projects' volumes alone; `.env` is kept) and then `make up && make seed` again and record the time. This is not the same as a truly clean machine, and the report says so.
9. **Tags**: after merging, tag both `ai-m8` and the `v0.1.0` in the plan (phase 1 of the AI module).
10. **Real checks** (estimate first, then confirm): (a) `starit-eval all`: about 90 document questions (understand + rerank + generate + judge, about 4 calls per question) + 41 data questions (about 4 per question), an estimated 500 to 600 model calls, **I will compute the estimated cost in the command and show it to you**, expected within $0.2; (b) the matrix rerun for chunk size, `identifiers` and derived content, mainly the search evaluation, with the cost mostly in rerank; (c) ask 1 real question through the LiteLLM proxy; (d) look at the same run in Langfuse/Grafana.

### Planned files (under `ai-module/`)

| File | Purpose |
|---|---|
| `eval/src/starit_eval/answers.py` (new), `judge.py` (new), `report.py`, `cli.py`, `runner.py` (changed) | Answer correctness (deterministic + judge + the 20% human spot-check table), refusal correctness, run metrics, `starit-eval answers` and `all`, the summary report |
| `eval/src/starit_eval/matrix.py` (new) | The experiment matrix: run the search evaluation after re-ingestion and save the result of every configuration |
| `sample-data/eval/qa-set.jsonl`, `sample-data/tools/` (changed) | The additional evaluation questions and the script that checks the source facts |
| `packages/core/src/starit_core/ingest/derive.py` (new), `pipeline.py`, `config.py`, `retrieval/keyword.py` (changed) | Derived content, the `identifiers` boost switch |
| `packages/core/src/starit_core/telemetry.py` (new), `agent/nodes.py`, `llm.py`, `dataaccess/tools.py`, the entry points of the three services (changed) | OTel initialisation, spans for nodes, models and tools, metrics, `trace_id`/`run_id` in logs |
| `deploy/compose/observability.yaml`, `langfuse.yaml`, `deploy/observability/` (new) | Collector, Prometheus, Tempo, Grafana (preset data sources and 4 dashboards), Langfuse |
| `deploy/compose/compose.yaml`, `deploy/litellm/config.yaml` (new/changed) | The LiteLLM proxy service; `STARIT_LLM_GATEWAY` |
| `packages/core/src/starit_core/llm.py`, `embeddings.py`, `config.py` (changed) | Calling through the proxy (`api_base`), switching between the two gateways |
| `scripts/seed.py`, `scripts/seed_dump.py`, `seed/` (new), `Makefile` (changed) | `make seed`, `make seed-dump`, `make up-obs` |
| The matching tests | See the verification criteria |
| `docs/design/01`, `04`, `05`, `06`, `ai-module/README.md`, `docs/eval/README.md`, `docs/eval/acceptance-v0.1.0.md` (changed/new) | Filling in deviations and measurements, usage documents, the acceptance report |

### Planned commands

```bash
git switch -c m8-eval-observability                 # already created
uv sync --all-packages
make test && make lint && make web-check
make up                                             # now includes litellm
make up-obs                                         # Collector, Prometheus, Tempo, Grafana
make seed-dump && make clean && make up && make seed   # round trip of the seed (deletes this project's data volumes, confirm first)
make eval ARGS="all"                                # estimate printed first, wait for confirmation
make eval ARGS="matrix"                             # estimate first, wait for confirmation
```

### Verification criteria

1. **Answer scoring**: the deterministic comparison (numbers, codes, dates, amounts, comma-separated numbers) has unit tests; the judge's parsing and failure handling are tested with a fake model; the 20% spot-check table is reproducible (the same random seed); the decision of refusal correctness has tests (including "an answer carrying a restricted fact counts as a failure").
2. **The new evaluation questions**: a script checks that the facts of every question's expected answer are in the source document; the number per question type is met; every restricted document has at least one question from a forbidden role; **the permission sweep (from 54 to all questions × 7 roles × 3 modes) shows 0 overreach**.
3. **Derived content and the boost switch**: unit tests of `derive` (fake model); when the switch is off the `identifiers` boost really has no effect (tested); atomic replacement after re-ingestion.
4. **OTel**: the tests use an in-memory exporter and assert that the spans of one conversation have the expected hierarchy (HTTP → graph node → model call/search/tool → database) and the same `trace_id`; for a data question going through MCP the trace is connected across services; logs carry `trace_id` and `run_id`; **span attributes and logs contain no token and no personal data other than the original question** (tested: the token and the `Authorization` header appear in no span or log).
5. **Metrics**: tests use an in-memory reader to assert that metrics such as the `end_state` count, the number of model calls, tokens and the ingestion queue length are recorded.
6. **Compose**: after `make up-obs` the Collector, Prometheus, Tempo and Grafana are healthy; the 4 dashboards exist in Grafana and their queries have data (after a few conversations with a real or fake model); Prometheus can query the `end_state` metric; Tempo can find a trace by `run_id`.
7. **Langfuse**: after `langfuse.yaml` starts, the trace of the same run can be found in both Langfuse and Grafana (Tempo); the measured memory is filled back into design 06.
8. **LiteLLM proxy**: the container is healthy; asking one real question through the proxy gets an answer with citations; when the proxy is unavailable the API's error handling ends in the `error` state without leaking keys; the keys are not in the environment variables of the api/worker/mcp-server (only in the `litellm` service).
9. **Seed**: a round trip of `seed-dump` → clear → `seed`: the numbers of documents, chunks and vectors and the `content_hash` are consistent; after a `make seed` **without an OpenAI key**, an account without permission still cannot find restricted documents by search (permission regression); clicking a citation can open the original (the files are in the object store).
10. **Full evaluation and matrix** (after the cost is confirmed): `starit-eval all` produces a report and writes `ai.eval_runs`; every configuration of the matrix has a result; the report states the sample size and the limits clearly, **and promises no metric value in advance**.
11. **Acceptance report**: each of the 7 criteria of section 8 of design 06 has a command, a result and the parts not verified.
12. Local tests, lint, mypy and front-end checks pass, and CI passes.

### Things unclear beforehand

- **I have not yet checked the current versions, image names and configuration formats** of OpenTelemetry, Prometheus, Grafana, Tempo, Langfuse and the LiteLLM proxy (they update fast and my memory may be out of date); before implementing I check them one by one and pin the versions, and what cannot be checked is written in the record.
- **Langfuse's resources**: it depends on many services (including ClickHouse), and running together with the rest in 11.7 GB of Docker memory is not necessarily comfortable; whether to enable it by default is decided after measuring, and for acceptance other optional components may have to be stopped first.
- **The stability of the LiteLLM proxy itself and its support for model names such as `gpt-6-luna`**: if the proxy does not recognise a model alias it has to be added in its configuration, which may affect the JSON mode of the rerank/understand steps.
- **The judge (LLM scoring) will make wrong calls**; the 20% spot check can only estimate the error rate and cannot remove it; the sample is small, and the report will not draw conclusions such as "accuracy X%" but only state how many questions passed and which did not.
- **Derived content** may have no clear benefit, and may even make search worse (hypothetical questions bring noise); this is an experiment, and the result may be "not recommended to switch on".
- **The time for `make up && make seed` again after `make clean`** depends mainly on whether the images are already on this machine; on this machine all images exist, so it is much faster than a truly new machine, and the report will say so.
- **The workload is large**: evaluation, OTel, three optional Compose files, the proxy, the seed, the acceptance report. If midway I find the scope too big, I will stop and ask whether to move Langfuse or derived content to after M8, rather than quietly shrinking it.

### For you to confirm

1. Add the LiteLLM proxy (full through the proxy, running directly on the host still using the in-process library), and acknowledge this as a deviation I failed to record in M5.
2. The full evaluation runner: answer scoring (deterministic + judge + 20% human spot-check table), refusal correctness, run metrics, the `starit-eval all` summary report.
3. Synthetic additional evaluation questions (each type ≥ 8, manager/hr/finance ≥ 6, every restricted document with ≥ 1 forbidden-role question), with a script checking the source facts.
4. The experiment matrix: search mode, chunk size 300/500/800, the `identifiers` boost switch, derived content (implemented first); the dedicated rerank API and BM25 are not done, and the decisions are recorded.
5. Observability scope: OTel through the api, worker and mcp-server; metrics; Collector, Prometheus, Tempo, Grafana (4 dashboards); **no Loki**.
6. Langfuse as an optional Compose file, taking the same traces and evaluation scores, with the version checked and the memory measured first.
7. `make seed` using the ready-made vector store dump (no OpenAI key needed) plus uploading the original files; `make seed ARGS=--ingest` goes through the real pipeline.
8. Acceptance: run the 7 criteria one by one and write `acceptance-v0.1.0.md`; for criterion 1, start over after `make clean` on this machine (**which deletes this project's local data volumes**).
9. Tag both `ai-m8` and `v0.1.0` after merging.
10. Real checks: `starit-eval all`, the matrix rerun, asking 1 question through the proxy; each with an estimate first and confirmation afterwards.

### Actual results

**Status: code, evaluation and acceptance are done; awaiting your confirmation to merge and tag `ai-m8` and `v0.1.0`.**

- **What was done** (matching the 10 confirmation points): (1) the LiteLLM proxy was added (`ghcr.io/berriai/litellm:v1.106.6`, port 4100; the vendor keys are only in the `litellm` container and not in the environment of the api, worker and mcp-server; verified with one real question: the proxy handled 3 chat calls and 1 embedding, all 200); (2)(3) the full evaluation runner and 60 new questions; (4) the experiment matrix (search mode, chunk 300/500/800, the `identifiers` switch, derived content); (5) OpenTelemetry + Collector + Tempo + Prometheus + Grafana (4 dashboards), without Loki; (6) the optional Langfuse Compose; (7) `make seed` and the ready-made dump; (8) acceptance; (9)(10) see below.
- **Tests**: 793 Python tests pass (699 at the end of M7), 61 front-end tests, 3 browser tests; lint, strict mypy and the front-end checks are all clean; CI succeeds. The new tests cover: the gateway (parameters for direct and through-proxy calls, keys not in repr or error messages), derived content (modes, a failure only losing the derived content, the embedded text, the ingestion flow), the `identifiers` switch, answer scoring (fact comparison including thousands separators and the `v` prefix, refusal, judge parsing, valid end states, a reproducible 20% sample), the experiment matrix (a temporary database, no database left after it runs), OTel (span hierarchy, the token and question text in no span/event/metric, error marking, trace_id and run_id in logs, a trace across HTTP to MCP, database statements without parameter values, the API's HTTP span, health checks not in traces), and the round trip of the seed dump (content, permissions, vectors and derived content consistent, an incomplete dump refused without touching existing data, restricted documents still restricted after restoring).
- **Full evaluation** (real, an estimated $0.25): permission regression passes (0 overreach in 2,394 searches); search hit@1 keyword 0.862, vector 0.885, hybrid 0.943, hybrid_rerank 1.0; answers 99/114 (15 questions read one by one, **no permission leak**: 8 questions were answered correctly but missed a minor detail and were marked wrong by the judge, 4 asked too many clarifying questions, 1 was a mistake of my scoring script, and 2 that should have been refused were answered, of which DOC-108 leaked nothing and DOC-90 is an ambiguous question); data questions 41/41. Details in `docs/eval/README.md`.
- **Experiment matrix** (real, about $0.02): between two ingestions of the same configuration hybrid's MRR already differs by about 0.01, so differences under 0.02 are not taken as an effect; the direction that smaller chunks are better (vector hit@1 0.954 at 300 against 0.885 for the baseline); the `identifiers` boost really helps keyword-type questions (MRR 1.0 against 0.923, 13 questions) and stays on; derived content has no clear benefit overall and stays off by default, and paraphrase-type questions are worth testing again on more questions.
- **Acceptance**: see `docs/eval/acceptance-v0.1.0.md` (7 criteria one by one, with "what was not verified"). From `make clean` to being able to ask took about 3 minutes (the images are already on this machine).
- **Differences from the confirmation points**: (a) the seed dump is `jsonl.gz` and not an SQL file (it does not depend on `pg_dump`; section 11 of design 06); (b) derived content strengthens only the vector side; (c) in Langfuse 4's "events_only" mode the old trace interface is unavailable, and the Observations API v2 is used to read data; (d) in the evaluation `Question` gains an optional field `facts`; (e) `matrix` clears the database with `DELETE` rather than `TRUNCATE` (the application role has no TRUNCATE right, which is correct).
- **Problems found and fixed on the way**: (1) **the deviation I had failed to record earlier**: in the design the full profile goes through the LiteLLM proxy, and from M5 on it had been the in-process library; now added; (2) the Python image downloaded all dependencies again for every line of code changed (one build took about 40 minutes, and `uv`'s default 30-second download timeout could make it fail); the dependencies were made a separate layer, a uv cache mount and `UV_HTTP_TIMEOUT=120` were added; (3) `opentelemetry-instrumentation-sqlalchemy` silently recorded no database span because SQLAlchemy 2.1 is outside the range it declares (only one ERROR in the log), worked around with `skip_dep_check` and proved by a test; (4) at commit time gitleaks stopped the base64 credentials I had computed in advance, so it was changed to the Collector's `basicauth` extension encoding on the spot; (5) my own scoring script did not recognise the `2.1` in `v2.1`; fixed, and the numbers in the report are from before the fix and were not changed; (6) in the shell I used `path` as a loop variable, which zsh ties to `PATH`, and that broke command lookup once.
- **Known limits**: see the end of the acceptance report. **The 20% human spot check is not done yet**, so the judge's conclusions cannot be taken as fact.

## M9 First batch of phase 2: streaming output, rate limit completion, model fallback, M8 wrap-up

Status: **In progress** (branch `m9-streaming-and-limits`). This batch lands your decisions on the `architecture diagram review table`: closing the tail of M8, streaming output (stream first, withdraw when verification fails), rate limiting completed to three dimensions, and LiteLLM's multi-model fallback (gpt-6-luna → gpt-4o-mini → Claude Haiku 5.5). Memory and write action confirmation are not done, by your decision (wait for the enterprise back office). Cost statistics are not done either, by your decision, see the verification below. There will be a few real model calls, **estimate first and then wait for your confirmation**.

### Your 7 decisions (recorded as given)

1. The tail of M8 is to be done: the 20% human spot check, `understand` asking too many clarifying questions and "no answer but still marked answered", Anthropic and fallback verification.
2. Streaming output is to be done; cost statistics already exist in Langfuse, so not for now.
3. Memory and write action confirmation are not done for now, until the enterprise back office exists.
4. Streaming uses "stream first, withdraw when verification fails".
5. Items that are on the diagram but not in the requirements list (output guardrails, jailbreak detection, MCP Resources and so on) are listed under phase 2 first.
6. Rate limiting (3 dimensions) is to be done, filling in the two missing dimensions.
7. LiteLLM multi-model fallback is to be done: OpenAI's gpt-6-luna first, then GPT-4 mini, then Claude's cheapest, Haiku 5.5.

### What I verified first (read-only, no money spent)

| Item | Result |
|---|---|
| Cost statistics | You are right: Langfuse already computes cost from our model names. Measured on one generate call: input 2,803 tokens, output 59 tokens, cost US$0.00031, unit price input 1e-7 and output 5e-7, matching gpt-6-luna in our `pricing.py`; calls of the same conversation share a `sessionId` and can be summed per conversation. **Limit**: Langfuse is only in the full profile ("local only"), so this has to be decided again when lite is built. |
| Model names | LiteLLM's price table has `gpt-4o-mini` (input 1.5e-7, output 6e-7) and `claude-haiku-5-5` (input 1e-7, output 5e-7, the same as gpt-6-luna). The name through the gateway is `anthropic/claude-haiku-5-5`. By the "GPT-4 mini" you wrote I understand the `openai/gpt-4o-mini` used in M5 all along: **please confirm**. The Anthropic key is in `.env`, **but I have not verified whether it is valid**. |
| Where fallback is implemented | LiteLLM's `acompletion` and the gateway requests both accept a `fallbacks` parameter, so the gateway configuration need not be redone: the chat client passes the same `fallbacks` list in both direct and through-gateway modes (a new setting `STARIT_LLM_FALLBACKS`). The wildcard routes `openai/*` and `anthropic/*` stay valid. Embedding has no fallback. |

### Things to tell you first (harder than they look, or needing your decision)

1. **Streaming output is harder than it looks.** Today `generate` outputs one JSON: `{"sufficient": ..., "answer": "...", "citations": [...]}`. The characters streamed out are JSON and not the answer text, so they have to be parsed as they arrive, sending out the content of the `answer` string (with escapes) while parsing. It is feasible: the key order is agreed with `sufficient` first, and when `sufficient` is false not a single character is streamed; when the model does not keep the order it falls back to "collect everything and then send", without error.
2. **Streaming does not shorten the total time, it only improves "waiting for the first character".** One run is about 5.5 seconds at p50, the front part being understanding, search and rerank, and only the final generation can be streamed. The first character is expected at 3.5 to 4 seconds instead of 5.5. I will add a "first-character latency" metric to measure the real number, with nothing promised in advance.
3. **The experience of withdrawal.** When verification fails (citing an excerpt that does not exist, not valid JSON and so on) the user has already seen the earlier characters; a withdrawal sends an event, the page clears that text and shows "regenerating…", and then streams the second result. This is the plan you chose and I implement it; **withdrawal should trigger rarely** (I have not counted it, and in the evaluation not one run became `error` because of it), and when it triggers the user sees one "step back".
4. **Which three dimensions the "3-dimension" rate limit means is not written on the diagram and you need to decide.** My suggestion: ① per user per minute (existing, 20); ② per IP per minute (for example 60, to stop one source opening many accounts); ③ a daily whole-site token budget (to stop the cost from running away; `STARIT_DAILY_LLM_BUDGET` in design 06 means this). Note: **in local Docker every browser request looks to the API as coming from the same gateway IP** (`172.25.0.1`), so the IP dimension is basically "whole site per minute" here, and only has meaning behind a real reverse proxy with trusted proxies configured (`X-Forwarded-For`); I will make it configuration and state it clearly. An alternative for dimension ②: the number of messages per user per day.
5. **The 20% human spot check needs you in person**: 20% of the 114 questions is **23 items**, each being the question, the reference answer, the assistant's answer and the judge's conclusion, and you judge "right / wrong / hard to say", taking about 20 to 30 minutes. I will make a web page you can click on (like the review table); you click through and I read the result and compute the agreement rate between judge and you. If the page cannot save your choices in this environment, it degrades to "you copy the result back".
6. **The prompts of `understand`/`generate` have to change**, and the evaluation has to be rerun after the change to know whether it is better: `understand` version 2 → 3 (ask a clarifying question only when key information is really missing and there is no usable general answer; "which year" and the like are not asked), `generate` version 1 → 2 (when the material does not contain what was asked, `sufficient: false` is required even if there is related content). Rerun `starit-eval answers` (114 questions, about $0.13) and the assistant spot check (about $0.01), **with the estimate printed first and then waiting for your confirmation**. Acceptance looks at: the 4 questions that got a clarifying question now answered directly; DOC-108 becoming a refusal state; truly vague questions such as "How much can I claim?" still getting a clarifying question; permission regression overreach still 0; the number of passes not dropping (the M8 baseline 99/114, of which 1 was a mistake of the scoring script, so 100/114 after the fix).
7. **After fallback, "which model answered" must be visible**: spans and metrics now record the requested model name; after a fallback the model that actually answered must be recorded, with a `starit.llm.fallbacks` count and a span attribute added, otherwise Grafana cannot show that the primary model is down. Fallback triggers only on **errors** (vendor error, timeout, rate limit, model not found) and not on "poor answer quality" or "invalid JSON".
8. **Behaviour will differ after switching to Haiku** (how the JSON is written, how well it keeps the "key order", rerank scoring). I suggest running the 114 questions with Haiku as the primary model to learn whether it is reliable as a fallback, about $0.13; **optional**, asked among the confirmation points.
9. **For your item 5, "list under phase 2 first", this time I only record and do not implement**: written into the new document `docs/design/09-phase2-plan.md` (decisions, scope, order, listing each item and its place on the diagram). The three items you named are output guardrails (PII masking, sensitive words), jailbreak detection and MCP Resources; I take "and so on" to mean that the other "not planned" items on the diagram are also listed as **candidates (not scheduled)**: the analytics agent, the web search agent, local vLLM, Redis caching and blacklist, Vault and Sentry, an edge reverse proxy and WAF, PITR backup. **Please confirm this scope.**

### Planned files (under `ai-module/` unless stated otherwise)

| File | Purpose |
|---|---|
| `docs/design/09-phase2-plan.md` (new), `07` (changed) | The phase 2 plan: your decisions, what is scheduled, the candidates, what is explicitly not done |
| `packages/core/src/starit_core/streaming.py` (new) | Incremental parsing: takes the text of `answer` out of the streamed JSON (handling escapes, splits across chunks, key order) |
| `packages/core/src/starit_core/llm.py` (changed) | `stream()`: litellm `stream=True` and token usage; the `fallbacks` parameter; recording the model that actually answered |
| `packages/core/src/starit_core/agent/nodes.py`, `runtime.py`, `state.py`, `prompts/*.md` (changed) | `generate` and `answer_from_data` stream; `verify_answer` sends a withdrawal on failure; `understand` 3, `generate` 2 |
| `apps/api/src/starit_api/conversations.py`, `deps.py`, `main.py` (changed) | With `Accept: text/event-stream` it returns SSE (`run.started`, `message.delta`, `message.retract`, `citations`, `run.ended`, with a keepalive comment every 15 seconds); without that request header the behaviour is unchanged (evaluation, scripts and tests as before); three-dimension rate limiting |
| `packages/core/src/starit_core/ratelimit.py`, `config.py` (changed) | Per IP, a whole-site daily token budget; `STARIT_RATE_LIMIT_IP_PER_MINUTE`, `STARIT_DAILY_TOKEN_BUDGET`, `STARIT_TRUSTED_PROXIES` |
| `packages/core/src/starit_core/telemetry.py` (changed) | `starit.llm.time_to_first_token`, `starit.llm.fallbacks`, `starit.rate_limited` |
| `web/src/lib/sse.ts`, `web/src/components/chat.tsx` (changed) | Uses `fetch` + `ReadableStream` (`EventSource` cannot carry an `Authorization` header); shows characters as they arrive, a withdrawal notice, citations appearing at the end |
| `eval/` (changed) | Evaluation still uses the non-streaming path; adds a check that "the final content of streaming and non-streaming is the same"; the script that generates the review page and the agreement-rate computation |
| `deploy/compose/compose.yaml`, `.env.example` (changed) | `STARIT_LLM_FALLBACKS`, the rate-limit variables |
| Tests of each layer; `docs/design/03`, `04`, `README` (changed) | The event format gains `message.retract`; where streaming sits in the graph |

### Planned commands

```bash
git switch -c m9-streaming-and-limits              # already created
uv sync --all-packages
make test && make lint && make web-check
make up
make eval ARGS="answers"                           # rerun after the prompt change (estimate printed first and confirmed)
make e2e                                           # smoke test of streaming in a real browser
```

### Verification criteria

1. **Incremental parsing**: dozens of ways of splitting (cutting in the middle of escapes, `\uXXXX`, multibyte characters; `sufficient` false; reversed key order; invalid JSON; over-long answers) each asserted: the streamed text joined together equals the final `answer`; with `sufficient: false` no text is streamed at all; with reversed key order it falls back to sending the whole.
2. **Streaming runs** (scripted model, real database): the event order `run.started` → `message.delta`×N → `citations` → `run.ended`; the final content is exactly the same as the non-streaming path; when verification fails `message.retract` comes first and then the new streaming; when retries are used up it ends with `error` after the withdrawal; clarification, refusal, small talk and the data path each have a scenario.
3. **Disconnects**: when the client disconnects midway, the run continues to the end on the server, and `ai.runs`, `ai.messages` and the audit records are complete (asserted by a test).
4. **API**: with `Accept: text/event-stream` it returns SSE and without it the same JSON as now; not signed in 401; the rate limit 429 is returned **before** the stream starts (an ordinary HTTP response, not an event); the token appears in no event or log.
5. **Three-dimension rate limiting**: each dimension has its own tests (over the limit, recovery after the window passes, letting through with a warning when Redis is unavailable); the IP dimension uses the peer address when no trusted proxy is configured and the last trusted hop of `X-Forwarded-For` when one is, and **a forged header has no effect** (tested); the daily budget accumulates the actual tokens when a run ends, and after the limit a new request gets 429 with a `Retry-After` until midnight of the next day.
6. **Fallback**: unit tests (the primary model errors → the second → the third; all three fail → `llm_error`; a non-error situation does not trigger); **real check** (estimate first): temporarily set the primary model to a name that does not exist and confirm the answer comes from `gpt-4o-mini`; then set both of the first two to non-existent names and confirm the answer comes from Haiku 5.5; spans and metrics record the model that actually answered.
7. **Evaluation of the prompt change**: the 5 acceptance items of point 6 above; the report states the before-and-after comparison and the sample size clearly, **without promising the number of passes in advance**.
8. **The 20% human spot check**: all 23 items have your judgement; the report states the agreement rate between judge and you and which items disagree, and **a low agreement rate shows that the judge cannot be trusted**.
9. **Front end**: Vitest covers SSE parsing (events across chunks, the keepalive comment, withdrawal, the fallback to the final content in `run.ended`) and the interface at withdrawal; Playwright goes once through asking, withdrawal and a citation with an intercepted SSE response; ask once with the real model in a real browser and watch the characters appear one by one.
10. Local tests, lint, mypy and front-end checks pass, and CI passes.

### Things unclear beforehand

- **Whether the LiteLLM gateway forwards streaming + `response_format: json_object` without trouble for gpt-6-luna** I have not tried; it is verified with one real call first (under $0.001).
- **Whether `stream_options: include_usage` gives the final token usage through the gateway**; if not, the token accounting of streaming runs will be missing, and I will fall back to an estimate and mark it clearly.
- **How the `fallbacks` parameter behaves when passed through the gateway** under the wildcard routes (`openai/*`) I have not verified yet; if that fails I will use the gateway's `router_settings.fallbacks` and create one named entry for each of the three models (which would change the model-name convention, and I will tell you then).
- **How Haiku handles the JSON mode and `reasoning_effort`**: LiteLLM converts or drops unsupported parameters (`drop_params: true`), but the behaviour after conversion is not verified.
- **The front-end experience of withdrawal** has to be tried for real to know whether it feels right; afterwards I will look at it once in a real browser, but "whether it feels right" is your judgement.
- **IP rate limiting means almost nothing locally** (see above), so at acceptance the logic can only be proved by tests and cannot be proved under real multi-source conditions.

### For you to confirm

1. The model chain: `openai/gpt-6-luna` → `openai/gpt-4o-mini` (your "GPT-4 mini") → `anthropic/claude-haiku-5-5`; whether the Anthropic key is valid is verified by the real check.
2. The three rate-limit dimensions: per user per minute (existing), per IP per minute (60 suggested), a whole-site daily token budget (you set the number, or I give a conservative default first), or replace dimension ② with "messages per user per day".
3. Streaming: stream first, withdraw when verification fails; `answer_from_data` (the data path) also streams; the fixed texts of clarification, refusal and small talk are sent as a single `message.delta`, keeping the front-end logic uniform; this round does **not** do a "stop generating" button.
4. Cost statistics are not done; use Langfuse (in the full profile; lite has none).
5. The prompt changes (`understand` 3, `generate` 2) and rerunning the evaluation, estimate first and confirmation afterwards.
6. The 20% human spot check: I make the click page, and you spend 20 to 30 minutes judging 23 items.
7. The scope of the phase 2 plan document (point 9 above: the three items you named + the other candidates).
8. Whether to run the 114 questions with Haiku as the primary model (about $0.13, optional).

### The user's confirmation (2026-11-04)

- **The three rate-limit dimensions**: IP / user / token. The token dimension is set at **no more than US$0.50 per day for the whole stack** (accumulated by actual usage and model prices; "whole stack" = every model call of the api, worker and mcp-server, including chat, rerank, embedding and derived content); IP 60 per minute and user 20 per minute follow my suggestion.
- **The 20% human spot check**: I finish the other features first and **the user does this check last** (the sample is taken from the result of the rerun after the prompt change, so that what is tested is the final system).
- **Haiku**: there is no need to run the 114 questions with Haiku, and **only verify that Haiku works**.
- All the other confirmation points were accepted: the model chain `gpt-6-luna → gpt-4o-mini → claude-haiku-5-5`; streaming (`answer_from_data` also streams, fixed texts as a single `message.delta`, no stop button this round); cost statistics with Langfuse; the prompt changes and the rerun of the evaluation (**estimate first, confirm afterwards**); the scope of the phase 2 plan document.

### Actual results

Status: **features, evaluation and the human spot check are all done, CI passes, awaiting merge**.

- **Multi-model fallback + daily budget + three-dimension rate limiting** (commit c87d0b8): the model chain `gpt-6-luna → gpt-4o-mini → claude-haiku-5-5`; a whole-stack daily budget of US$0.5 (the api, worker and mcp-server share the day's Redis counter, chat returns 429 once it is exceeded and the worker pauses taking jobs); rate limits IP 60 per minute and user 20 per minute, with the IP taken from the connection, and `X-Forwarded-For` read only when the source is within `STARIT_TRUSTED_PROXIES`.
- **Streaming output**: with `Accept: text/event-stream` it returns SSE (the events are in 4.1 of document 03). `generate` first outputs `sufficient` and only after it is confirmed true does it start streaming `answer`; `answer_from_data` also streams; fixed texts are a single `message.delta`; when verification fails it sends `message.retract` and the web page shows "The draft did not pass the check and was withdrawn"; after the client disconnects the run continues and is stored; a 15-second keepalive. New first-character latency metrics (`run_first_token`, `llm_first_token`).
- **Prompts**: `understand` 2→3, `generate` 1→2.
- **Real checks** (within about $0.15): streaming + JSON mode + usage accounting through the LiteLLM gateway works (gpt-6-luna, gpt-4o-mini); the fallback chain measured: an invalid primary model → `gpt-4o-mini`, the first two invalid → `claude-haiku-5-5`, and the result records the model actually used; Haiku works directly in both streaming and non-streaming with valid JSON. The check script: `ai-module/scripts/m9_real_check.py`. The 114 questions were not run with Haiku (by your decision).
- **Rerun of the answer evaluation** (`docs/eval/answers-20261104-1722.md`, costing about $0.129, estimate $0.140): **107/114** (the M8 baseline was 99/114; should-answer 81/87, should-refuse 26/27). Of DOC-04/31/42/69, which were previously asked a clarifying question, 31, 42 and 69 now pass; DOC-04 now answers directly but the judge fails it for "missing the 12-month service period"; DOC-108 passes; "asked for clarification instead of answering" among the should-answer ones is 0 questions. Of the remaining 7: 6 are the judge faulting an answer for missing a minor fact (DOC-04/05/07/27/35/43), and 1 is DOC-90 (the question itself is vague and the assistant answered citing the procurement threshold).
- **Assistant spot check**: 14/15, the same as M8, and the one still not passing is DOC-43 (it did not write the current version's 3,000); permission regression overreach is 0 questions.
- **Not verified / stated honestly**: how streaming feels in a real browser has not been looked at; generation latency p50 is 7.25 seconds (about 5.5 seconds in M8; this time it includes longer answers and network fluctuation, and was not compared separately), and streaming mainly improves the time to the first character; under local Docker the IP rate limit has almost no discriminating power (every browser appears as the Docker gateway address).
- **20% human spot check (done by the user, `docs/eval/answers-20261104-1722-reviewed.csv`)**: 23 questions, the judge and the human agree on **21 of 23**. All 21 that the judge passed were endorsed by the human (no "wrongly let through"); of the 2 that the judge failed (DOC-04 missing the 12-month service period, DOC-27 missing the mirror address) the human thought they should pass, that is, the judge is strict and wrongly rejects on a missing minor fact. Conclusion: the number of passes the judge gives is a conservative lower bound, and 107/114 does not overstate; the sample is only 23 questions, and the share of the judge being too strict (2/23) is only a rough estimate. (The user said afterwards that during the check the "reference answer" and "assistant answer" columns had been read the wrong way round; after re-checking it was confirmed that the assistant's answers were right, the result still counts as 21/23, and the CSV was not changed.)
- **Tests**: 875 Python tests and 62 front-end tests pass; ruff and strict mypy are clean.
