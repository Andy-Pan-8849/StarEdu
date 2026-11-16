# Design document 02: data model and permission metadata (AI module, phase 1)

[中文](02-data-model.chn.md)

Status: **Approved by the user (2026-11-02); all 6 confirmation points of section 8 were accepted.** No application code is written and no tables are created before the other design documents are approved.
Depends on: [01 overall architecture](01-architecture-and-repo.md). Marking convention as in 01: **[Decided]**, **[Proposed]**, **[Open]**.

## 1. General principles

1. **Permission and version information travels with the chunk**: each chunk stores who may see it and which version it belongs to, so search filters within one table without joins.
2. **Permissions are enforced by code**: every search SQL is produced by the same function in `core`, and the function must receive the user's identity; there is no "search without identity" entry.
3. **At ingestion, permissions are expanded into explicit sets** (such as `allowed_roles`), so a query only does set operations and never computes role inheritance.
4. **Keycloak is the only source of users and roles**: the AI side has no user table and stores only Keycloak's user id (`sub`).
5. Tables of the AI side live in the Postgres `ai` schema, the sample business data in the `biz` schema, and the SQL agent reaches data through allow-listed views in the `ai_sql` schema (see section 5). Migrations use Alembic.
6. **Three database accounts** [M2 revision, Decided]: `starit` (database owner, used only for migrations), `ai_app` (the application account, ordinary rights; the audit table has INSERT only), `ai_sql_ro` (read-only, **cannot log in**; the application switches to it inside a transaction with `SET LOCAL ROLE ai_sql_ro` to run the SQL agent's queries). The application no longer connects as a superuser, otherwise grants and the append-only audit would be void.
7. **Two kinds of access control** [M2 revision, Decided]: **policy documents** exist once for the whole company and are controlled by **role** only (the access level, see 2.3), regardless of campus; **structured data and campus materials** (student lists, tickets, submissions, expense claims, and later courseware and handouts) are controlled by **data scope**: whole company / own campus / own records only. This matches the usual "data permission" of enterprise back offices.

## 2. Documents and chunks

### 2.1 `ai.documents`

| Column | Type | Description |
|---|---|---|
| `id` | uuid PK | |
| `doc_code` | text | Business code such as `FIN-PAY-004`; the `doc_id` of `manifest.csv` |
| `title` | text | |
| `domain` | text | `hr` / `finance` / `support` |
| `version` | text | such as `4.0` |
| `status` | text | `active` / `superseded` / `draft` |
| `effective_date` | date | |
| `access_level` | text | The original access level such as `hr-only` (see 2.3), kept for display and re-expansion |
| `allowed_roles` | text[] | The expanded set of roles |
| `allowed_users` | text[] | Named individuals (Keycloak `sub`), empty by default |
| `campus_scope` | text[] | `{all}` or a list of campus codes |
| `min_level_rank` | smallint | Optional minimum grade (1 to 7, see the table in section 4), empty by default |
| `object_key` | text | The original file in the object store |
| `format` | text | docx / pdf / md / txt |
| `content_hash` | text | SHA-256, to detect duplicate uploads and changes |
| `ingest_status` | text | `queued` / `running` / `ready` / `failed` |
| `uploaded_by` | text | Keycloak `sub` |
| `created_at`, `updated_at` | timestamptz | |
| `supersedes_id` | uuid null | Points to the older version it replaces |

Unique constraint: `(doc_code, version)`.

### 2.2 `ai.document_chunks`

| Column | Type | Description |
|---|---|---|
| `id` | uuid PK | |
| `document_id` | uuid FK | |
| `chunk_index` | int | |
| `text` | text | The original text, **always kept** |
| `heading_path` | text[] | Heading path |
| `page` | int null | |
| `token_count` | int | |
| `identifiers` | text[] | Codes extracted from the text by rules (such as `ERR-PORTAL-403`), used to boost exact matches |
| `tsv` | tsvector | Generated from `text` (including `identifiers`), GIN index |
| `allowed_roles`, `allowed_users`, `campus_scope`, `min_level_rank` | as above | **Copied from the document (denormalised)** |
| `status`, `effective_date`, `doc_code`, `version` | as above | Copied from the document, to ease filtering and labelling |

Consistency rule: a document's permissions, status and version can only be changed through one service function in `core`, which updates the document row and all of its chunks **in the same transaction**; changing one of them with direct SQL is forbidden. There is also a **consistency check view** `ai.v_chunk_permission_drift` that lists chunks whose permissions, status or version differ from their document; tests and CI assert that it is empty.

### 2.3 Expansion table from access level to roles [Decided, from the access model of the evaluation set]

The `access` of `manifest.csv` is expanded into `allowed_roles` at ingestion:

| `access` | Expanded `allowed_roles` |
|---|---|
| `students-and-staff` | student, staff, manager, hr, finance |
| `all-staff` | staff, manager, hr, finance |
| `staff` | staff, manager, hr, finance |
| `managers` | manager, hr, finance |
| `finance-and-hr` | hr, finance |
| `hr-only` | hr |

- `Admin` and `RAGETLAdmin` are **in no expansion result** (least privilege, see 4.3 of 01).
- The mapping is kept in a configuration file. When the mapping changes, a "re-expand" job is needed to update documents and chunks.

### 2.4 `ai.chunk_embeddings`

| Column | Type | Description |
|---|---|---|
| `chunk_id` | uuid PK FK | |
| `model` | text | such as `text-embedding-3-small` |
| `dimensions` | int | |
| `embedding` | vector(1536) | |

- The dimension of the vector column is fixed when the table is created. Switching to a model of a different dimension needs a new migration that creates a new table, and re-ingestion; `model` and `dimensions` are recorded on every row to detect mixing.
- **ANN index**: at sample scale (hundreds to thousands of chunks) the first version **does not build HNSW** and uses an exact scan with the filter conditions, which gives the most accurate results. HNSW can be added when needed, together with a measurement of the "fewer results after filtering" problem (newer pgvector versions offer iterative scans; the current version and behaviour must be checked) [Open].

### 2.5 `ai.chunk_derived`

| Column | Type | Description |
|---|---|---|
| `id` | uuid PK | |
| `chunk_id` | uuid FK | |
| `kind` | text | `summary` / `question` / `keyword` |
| `text` | text | |
| `tsv` | tsvector | |

- Derived content is an **extra field** and does not replace the original text (RAGFlow was found to let summaries replace the full-text index; we do not do that).
- At search time a hit in the original text weighs most and derived content supplements it; permissions are inherited from the chunk (joined at query time; derived content stores no permission columns itself).

### 2.6 `ai.ingestion_jobs`

| Column | Type | Description |
|---|---|---|
| `id` | uuid PK | |
| `document_id` | uuid FK | |
| `status` | text | `queued` / `running` / `succeeded` / `failed` |
| `stage` | text | `parse` / `chunk` / `derive` / `embed` / `write` |
| `attempt`, `max_attempts` | int | |
| `run_after` | timestamptz | Earliest time of a retry |
| `locked_by`, `locked_at` | text / timestamptz | Worker claim marks (`FOR UPDATE SKIP LOCKED`) |
| `config` | jsonb | Parser, chunking parameters, whether to generate derived content |
| `error_code`, `error_message` | text | Failure reason, shown on the document management page |
| `started_at`, `finished_at` | timestamptz | |

## 3. Conversations, runs and audit

### 3.1 `ai.conversations`

`id`, `user_id` (Keycloak `sub`), `title`, `created_at`, `updated_at`, `archived`. A conversation is created by the user and does not expire automatically [Decided].

### 3.2 `ai.messages`

`id`, `conversation_id`, `run_id`, `role` (user / assistant), `content`, `citations` (jsonb: document, chunk, page, version), `created_at`.

### 3.3 `ai.runs` (one row per graph run)

| Column | Description |
|---|---|
| `id`, `conversation_id`, `user_id` | |
| `started_at`, `ended_at` | |
| `end_state`, `end_reason` | The explicit End state and reason code (`answered` / `need_clarification` / `no_permission` / `not_found` / `refused` / `error`, see document 04) |
| `model`, `tokens_in`, `tokens_out`, `latency_ms` | The phase 2 cost statistics are summed from here |
| `trace_id` | The matching Langfuse / OTel trace |

LangGraph's checkpoint tables are created by its official Postgres checkpointer itself (under the `ai` schema), and the conversation state (`answering` / `need_clarification`) is kept in the graph state.

### 3.4 `ai.audit_log` (append-only)

`id`, `ts`, `user_id`, `roles` (jsonb), `action` (`chat.query` / `doc.upload` / `doc.delete` / `doc.reindex` / `access.denied` and so on), `run_id`, `query_text`, `doc_ids` (documents hit or acted on this time), `filtered_count` (the number of chunks removed by permissions, **only the count, never the content**), `ip`.

- The application account has INSERT only, no UPDATE / DELETE.
- Whether and how long to keep the original query text touches privacy; a demo project keeps it, a real environment needs a policy [Open].

## 4. The permission filter of search [M2 revision]

The filter built in `core` (shared by all searches):

```sql
status IN ('active', 'superseded')          -- old versions are included by default, and labelled in the result
AND ( allowed_roles && :user_roles
      OR :user_id = ANY(allowed_users) )     -- grants: OR
AND ( campus_scope = '{all}'
      OR :campus_id = ANY(campus_scope)
      OR :all_campuses )                     -- mandatory constraint: AND (data scope)
AND ( min_level_rank IS NULL
      OR :user_level_rank >= min_level_rank ) -- mandatory constraint: AND (grade)
```

- This matches the decision rule of round 6 of the requirements document: grants combine with OR, mandatory constraints with AND; an explicit denial (such as a disabled account) is handled in the authentication layer, and a denied user cannot get a valid JWT.
- `:all_campuses` being true means the user's role has the "whole company" data scope (`hr`, `finance`, headquarters functions, configuration item `COMPANY_WIDE_ROLES`). The `campus_scope` of policy documents is always `{all}`, so it only affects campus materials.
- **Old versions take part in search by default, labelled with `status`**: the evaluation set has questions such as "what was the old policy and which one applies now", and both versions must be seen; the rule at generation is to cite `active` first and say the old version has been superseded.
- Filtering must come before ranking (the filter goes into the `WHERE` of both the full-text and the vector search).

### Grade table [Decided, 2026-11-02]

A job level is made of a letter (the ladder) and a number: **I** = Instructor ladder, **S** = Staff (support functions) ladder, **M** = Management ladder. The three ladders cannot be compared directly, so they are mapped to one "grade" (1 to 7); document rules are written as "grade N and above".

| Grade | Levels |
|---|---|
| 1 | S1, I1 |
| 2 | S2, I2 |
| 3 | S3, I3 |
| 4 | I4 |
| 5 | I5 |
| 6 | M2 |
| 7 | M3 |

This is a convention of the demo project; a real company has its own mapping table. The table lives in configuration and is also written in `ai-module/sample-data/README.md`. No sample document has a grade limit at the moment, so it is reserved and tested with synthetic data.

## 5. Data access of the SQL agent [M2 revision]

Where the data is: the 7 sample CSV files are imported into the `biz` schema as seed data until the business module is done; later the business module's real tables replace them and the AI side only changes the view definitions.

How it is accessed:

1. **Accounts and switching**: the application connects as `ai_app`; to run a SQL agent query it first sets the identity session variables (`app.user_id`, `app.roles`, `app.campus_id`, `app.subject_id`) in one transaction, then `SET LOCAL ROLE ai_sql_ro`, and only then runs the query. `ai_sql_ro` cannot log in and can only read the **allow-listed views** of the `ai_sql` schema; it has no rights on the original `biz` tables or anything in the `ai` schema.
2. **Tamper protection**: the SQL being run must not change its own identity. The way is to revoke `set_config` execution from `PUBLIC` and grant it to `ai_app` only; `ai_sql_ro` cannot call it. M2 has a test that proves it, and M6 adds statement checks in the application layer (only a single `SELECT`, only allow-listed views, an allow-list of functions).
3. **Row filtering is a `WHERE` in the view** (reading the session variables), not Postgres RLS [Decided]. If stronger guarantees are needed later, RLS can be added on the original tables as a second safeguard.
4. Other limits: statement timeout, maximum number of rows returned.
5. When the identity variables are not set, every view returns nothing.

Visibility of the views [Decided, data scope; consistent with the evaluation set]:

| View | student | staff | manager | hr, finance | Admin, RAGETLAdmin |
|---|---|---|---|---|---|
| `campuses`, `assignments` | all | all | all | all | all |
| `students`, `submissions`, `support_tickets` | own records | own campus | own campus | whole company | none |
| `employees`, `expense_claims` | none | own records | own campus | whole company | none |

A ticket belongs to the **campus of the person who opened it**. "Own" is judged by the `student_id` / `employee_id` in the token.

The MCP tools "course and student data (read-only)" and "expense status" reuse the same views and the same session variables.

## 6. Evaluation tables (phase 1)

- `ai.eval_runs`: `id`, `started_at`, `git_sha`, `config` (jsonb: search mode, model, rerank or not), `summary` (jsonb: overall accuracy, permission regression pass rate).
- `ai.eval_results`: `run_id`, `question_id`, `role`, `answer`, `passed`, `retrieved_doc_ids`, `latency_ms`, `notes`.

The test accounts used for evaluation (at least one per role, plus a Beijing staff, a Shanghai staff and a Shanghai manager) are preset in Keycloak and are not stored in the `ai` tables.

## 7. Index and migration summary [Proposed]

- `document_chunks`: GIN on `tsv`; GIN on `allowed_roles` and `campus_scope`; a plain index on `document_id`.
- `chunk_embeddings`: no ANN index in the first version (see 2.4).
- `ingestion_jobs`: `(status, run_after)` for claiming jobs.
- `audit_log`: `(user_id, ts)`, `(action, ts)`.
- Full-text language configuration: `english` for the English data first; how code-like terms are tokenised (for example whether `ERR-PORTAL-403` is split) **needs measuring**, so the `identifiers` column is kept as the fallback for exact matches. A tokenisation plan is introduced when Chinese data arrives [Open].
- Migrations: Alembic, `ai` schema; the `biz` seed data is created by an import script and is not in the main Alembic line.

## 8. Points for you to confirm

1. Permission and version fields **copied to the chunk** (denormalised), kept consistent by a service function: accepted?
2. The expansion table (2.3) and "`Admin` and `RAGETLAdmin` are in no expansion result": accepted?
3. Old versions **take part in search by default and are labelled with status**: accepted?
4. **No ANN index** in the first version, an exact scan instead: accepted?
5. The 5-point plan of the SQL agent (allow-listed views + session-variable row filtering) and the first draft of the visibility: accepted?
6. `ai.audit_log` stores the original query text: accepted?

## 9. Confirmation results (2026-11-02)

All 6 points were accepted: permission and version fields copied to the chunk; the expansion table with the administrative roles outside every expansion result; old versions in search by default and labelled; no ANN index in the first version; the SQL agent on allow-listed views with session-variable row filtering; the audit log storing the original query text.

## 10. M2 revision record (2026-11-02)

The user confirmed: three database accounts; "an employee sees only their own campus" applies to structured data and campus materials, while policy documents exist once for the whole company and are controlled by role only, and `hr` and `finance` have whole-company data scope; the grade table (1 to 7); row filtering with a `WHERE` in the view. The sample data and the evaluation set were revised accordingly (M2.0).

## 11. M2 implementation record (2026-11-02)

- Migrations: 0002 (database roles, knowledge-base tables), 0003 (conversation, run, audit and evaluation tables, the consistency check view), 0004 (`biz` tables, the `ai_auth` helper functions, the `ai_sql` views, the `set_config` restriction). Roles are **shared by the whole database cluster**, so a downgrade only removes this database's grants and does not drop the roles; upgrading again reuses them.
- `tsv` is a generated column: `array_to_string` is only STABLE and Postgres rejects it, so a wrapper function `ai.text_array_join` declared IMMUTABLE solves it.
- The `ai_auth` helper functions called by the views run with the caller's rights, so `ai_sql_ro` needs `USAGE` / `EXECUTE` on them; they only read the caller's own identity settings, so opening them leaks nothing.
- The views use `security_barrier`, so that functions in a query cannot read rows before filtering.
- Identity is passed through five session settings: `app.user_id`, `app.roles`, `app.campus_id`, `app.employee_id`, `app.student_id`.
- Known limit: custom configuration items (`app.*`) cannot be protected from a `SET` statement by permissions. The defence now is: `set_config` is granted to `ai_app` only; the execution entry accepts only a single `SELECT` (it rejects multiple statements and `SET`). Statement checks (allow-lists of views and functions) arrive in M6.
