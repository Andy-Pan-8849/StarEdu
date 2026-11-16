# Design document 03: API and MCP contract (AI module, phase 1)

[中文](03-api-and-mcp-contract.chn.md)

Status: **Approved by the user (2026-11-02); all 7 confirmation points of section 8 were accepted.** No application code is written before the other design documents are approved.
Note: document 04 adds the End state `refused`, so the values of `end_state` in this document gain that item.
Depends on: [01 overall architecture](01-architecture-and-repo.md), [02 data model](02-data-model.md). Marking convention: **[Decided]**, **[Proposed]**, **[Open]**.

## 1. General conventions [Proposed]

- Paths have **no** prefix (M7 revision: since M5 they have been `/conversations`, `/documents` and so on; `/api/v1` is added when versioning is needed); JSON; times in ISO 8601 (UTC); ids are uuids (business codes such as `doc_code` are separate fields).
- **Authentication**: `Authorization: Bearer <JWT>`, issued by Keycloak and verified by the api with JWKS; identity comes only from the JWT, and any `user` or `role` field in a request body is ignored.
- **Common error format**:

```json
{ "error": { "code": "forbidden", "message": "…", "request_id": "…" } }
```

| HTTP | `code` | Case |
|---|---|---|
| 401 | `unauthenticated` | No JWT, expired, or invalid signature |
| 403 | `forbidden` | Signed in, but the role may not call this endpoint |
| 404 | `not_found` | The resource does not exist, **or the user may not see it** (existence is not revealed) |
| 409 | `conflict` | Duplicate upload (same `content_hash`), version conflict |
| 422 | `validation_error` | Invalid parameters |
| 429 | `rate_limited` | Rate limit (Redis) |
| 500 | `internal_error` | Any other error; only the `request_id` is returned, details are in the log |

- List endpoints: `limit` (default 20, maximum 100) + `cursor`, returning `{ "items": [...], "next_cursor": "…|null" }`.
- Every request carries `X-Request-Id` (generated if missing), written to the log and the trace.

## 2. Endpoint overview

| Group | Method and path | Who may call |
|---|---|---|
| Health | `GET /healthz` | Public |
| Identity | `GET /me` | Signed in |
| Conversations | `POST /conversations`, `GET /conversations`, `GET /conversations/{id}`, `PATCH /conversations/{id}`, `DELETE /conversations/{id}` | Signed in, own conversations only |
| Chat | `POST /conversations/{id}/messages`, `GET /conversations/{id}/messages` | Same |
| Document management | `POST /documents`, `GET /documents`, `GET /documents/{id}`, `PATCH /documents/{id}`, `DELETE /documents/{id}`, `POST /documents/{id}/reindex`, `GET /documents/{id}/jobs` | `RAGETLAdmin` |
| Document reading | `GET /documents/{id}/chunks`, `GET /documents/{id}/file` | Signed in, filtered by permission (see 4.2) |

Evaluation and audit queries have **no API** in phase 1: evaluation runs on the command line and writes a report, and the audit log is only in the database (phase 2 may add a query endpoint for an `Auditor` role).

## 3. Identity and conversations

### `GET /me`

```json
{ "user_id": "…", "name": "…", "roles": ["staff"], "campus_id": "SH", "level": "S2" }
```

Everything comes from the JWT claims, and the front end uses it to decide which menus to show (the document management page is shown to `RAGETLAdmin` only). **What the front end shows is not permission; the back end checks again on every endpoint.**

### Conversations

- `POST /conversations` → `{ "id", "title": null, "created_at" }`. The title is generated after the first question and answer, and can also be changed with `PATCH`.
- `DELETE` is an **archive** (`archived = true`), not a physical delete, in line with audit.
- Only the creator can reach a conversation; someone else's conversation id returns 404.

## 4. Chat

### 4.1 `POST /conversations/{id}/messages`

Request:

```json
{ "content": "I submitted an assignment 50 hours late and my raw score was 90. What is my final score?" }
```

Response (a one-shot JSON in phase 1, **with a structure already prepared for the streaming output of phase 2**):

```json
{
  "run_id": "…",
  "message": {
    "id": "…",
    "role": "assistant",
    "content": "50 hours late falls into the 48 to 72 hour band: 30 percent … final score 63. [1]",
    "citations": [
      { "n": 1, "doc_code": "TS-HW-006", "title": "…", "version": "1.0",
        "status": "active", "heading_path": ["…"], "page": 2, "chunk_id": "…",
        "kind": "document" }
    ]
  },
  "end_state": "answered",
  "end_reason": null
}
```

- The values of `end_state` and the reason codes are in document 04: `answered`, `need_clarification`, `no_permission`, `not_found`, `refused`, `error`. **Every run must return one of them.**
- `need_clarification`: `message.content` is the clarifying question, and the user simply replies in the same conversation; the state is kept in the graph's conversation-state field and does not rely on implicit variables.
- `no_permission` / `not_found`: the reply text is fixed, reveals no restricted content and returns no citations.
- Citations contain only documents **the user may see**; `n` matches the `[n]` in the text.
- Request timeout: the server caps one run (**[Proposed]** 60 seconds); on timeout it ends with `end_state: "error"`, `end_reason: "timeout"` and does not return 5xx.

The streaming version (implemented in M9): the same path with the request header `Accept: text/event-stream`. Rate limiting and the ownership check are the same as the non-streaming ones, and an ordinary JSON error (401/404/409/429) is returned before the stream starts. Events:

| event | data |
|---|---|
| `run.started` | `{ "run_id" }` |
| `message.delta` | `{ "text" }`: appended to the current answer |
| `message.retract` | `{ "reason" }`: withdraws all the answer text shown so far (the draft failed verification); a new `message.delta` may follow |
| `citations` | `{ "citations": [...] }`, the same `citations` array as above |
| `run.ended` | `{ "run_id", "message_id", "end_state", "end_reason", "content" }`: `content` is the final stored reply, and the client should go by it |
| `error` | `{ "code", "message" }`: only when the run itself crashes unexpectedly, after which the stream ends |

Conventions: `generate` first outputs `sufficient`, and only after it is confirmed `true` does it start streaming `answer` ("stream first, withdraw if it fails"); fixed texts (clarification, refusal, not found and so on) are sent as a single `message.delta`; a comment line `: keepalive` is sent after 15 seconds without events; after the client disconnects the run continues on the server and is stored, and can be read from the message list when the client comes back.

### 4.2 `GET /documents/{id}/chunks` and `GET /documents/{id}/file`

- Used to view the source after clicking a citation. **The permission check uses the same filter function as search**; if it is not met, 404 is returned.
- `RAGETLAdmin` can read the content only if their own business role allows it (see 4.3 of 01); otherwise they only see the metadata (the return of `GET /documents`).

## 5. Document management (`RAGETLAdmin` only)

### `POST /documents` (multipart/form-data)

| Field | Required | Description |
|---|---|---|
| `file` | yes | docx / pdf / md / txt |
| `doc_code`, `title`, `domain`, `version` | yes | |
| `status` | no | `active` by default |
| `effective_date` | no | |
| `access_level` | yes | Values in the expansion table of 2.3 of 02 |
| `allowed_users` | no | Array of Keycloak `sub` |
| `campus_scope` | no | `["all"]` by default |
| `min_level` | no | |
| `supersedes` | no | The `id` of the older version it replaces |

Behaviour: write to the object store, write `ai.documents` (`ingest_status = queued`), insert into `ingestion_jobs`, and **return 202 at once** with the document and job ids. The same `content_hash` with the same `(doc_code, version)` returns 409 with the id of the existing document.

> **M7 revision (2026-11-03)**: what was actually implemented differs from the above: `min_level` is a grade number from 1 to 7; `domain` takes `hr`, `finance`, `tech-support`; a single file is at most 20 MB, and the extension must match the file header; if the same `(doc_code, version)` already exists it returns 409 (the message carries the existing document's `id`); lists use `limit` + an opaque `cursor` (it encodes an offset); a document citation carries `document_id`, and with it `GET /documents/{id}/chunks?around={chunk_id}&window=1` returns the cited chunk with one chunk before and after; `GET /documents/{id}/file` returns the original file (`Content-Disposition: inline`). Cross-origin access from the browser is controlled by `STARIT_CORS_ORIGINS` (default `http://localhost:3000`, allowing only the `Authorization`, `Content-Type` and `X-Request-Id` headers, no cookies).

### The other endpoints

- `GET /documents`: filter parameters `domain`, `status`, `ingest_status`, `q` (title or code). Returns metadata, **without the body text**.
- `PATCH /documents/{id}`: can change title, status, `access_level`, `allowed_users`, `campus_scope`, `min_level`. A change of permission or status goes through the service function of 02, **updating the document and all its chunks in one transaction**, and writes an audit record.
- `DELETE /documents/{id}`: hard-deletes the document, chunks, vectors, derived content and the original file (a document management action, audited); citations in conversation history keep the `doc_code` text and are no longer clickable.
- `POST /documents/{id}/reindex`: creates a new ingestion job and, on success, replaces the old chunks atomically.
- `GET /documents/{id}/jobs`: ingestion job history, including `stage`, `attempt`, `error_code`, `error_message`.

## 6. MCP server [Proposed]

### 6.1 Transport and authentication

- A separate process, port 8100, streamable HTTP.
- When the agent calls a tool it **forwards the current user's JWT**; the MCP server verifies it itself with the same JWKS and checks that `aud` contains `starit-mcp`. The access token Keycloak gives the front-end client carries both audiences, `starit-api` and `starit-mcp`. [Open] A stricter way is token exchange, not done in phase 1.
- Every tool reads identity the same way: JWT → set the database session variables → access the allow-listed views through `ai_sql_ro`, or call the search function of `core`. Tools **accept no** identity parameter.

> **M6 revision (2026-11-03)**: citations gain a `kind` field. `"document"` is as above; `"data"` means the answer came from business data: `{ "n": 1, "kind": "data", "views": ["students"], "row_count": 12 }`. The real `top_k` of `search_documents` is at most 8, there is no `doc_code` parameter, `domain` (hr/finance/tech) filters on the `doc_code` prefix, and only `doc_code`, `title`, `version`, `heading_path` and `text` are returned. All tools return `{"ok": true, ...}` or `{"ok": false, "error": {"code", "message"}}`, with error codes `forbidden`, `not_found`, `invalid_argument`, `internal_error`.

### 6.2 First tools (confirmed scope: document search, read-only courses and students, expense status)

| Tool | Input | Output |
|---|---|---|
| `search_documents` | `query` (required), `top_k` (default 5, maximum 10), `domain`, `doc_code` | A list: `chunk_id`, `doc_code`, `title`, `version`, `status`, `heading_path`, `page`, `text`, `score` |
| `list_assignments` | `program` (optional) | The assignment list (`assignment_id`, `program`, `title`, `due_date`) |
| `list_students` | `campus_id`, `program`, `cohort`, `limit` (default 20) | A student list (filtered by the row rules of the view; a student only sees themselves) |
| `get_student_progress` | `student_id` | The submissions of that student: assignment, hours late, raw score, penalty percentage, final score |
| `get_expense_claim_status` | `claim_id` | Status, amount, category, submission date, approving role (only for oneself or those with permission) |
| `list_my_expense_claims` | `status` (optional), `limit` | The expense claims submitted by the current user |

Conventions:
- Tools use **fixed parameterised queries** and accept no SQL string. Free-form data questions are handled by the agent's internal read-only SQL tool (with statement checks, a timeout and a row limit, see section 5 of 02), which does not go through MCP.
- The output **does not return rows the user may not see**, and gives no information such as "how many rows were filtered".
- Tool errors use the standard MCP error, with `code` one of `forbidden`, `not_found`, `invalid_argument`, `internal_error`.
- Every call writes `audit_log` (`action = mcp.<tool>`), recording the user, the tool, a summary of the arguments and the number of rows returned.

## 7. Rate limits and timeouts [Proposed]

- Chat endpoint: 20 per user per minute; document upload: 5 per user per minute (Redis counters).
- One run is capped at 60 seconds; one LLM call at 30 seconds, with one retry on failure; search and the SQL tool have their own timeouts.
- Upload size limit: 20 MB (configurable).

## 8. Points for you to confirm

1. The endpoint split in section 2, especially "evaluation only on the command line, no audit API in phase 1": accepted?
2. The chat endpoint returns a one-shot JSON in phase 1, with the response structure prepared for streaming (SSE in phase 2): accepted?
3. Return 404 for a document the user may not access (existence not revealed): accepted?
4. `RAGETLAdmin` can read document content only if their own business role allows it, otherwise only the metadata: accepted?
5. The MCP tool list and parameters of 6.2: accepted? (especially that `list_students` returns only themselves to a student)
6. MCP forwards the user's JWT and checks `aud`, with no token exchange in phase 1: accepted?
7. The rate-limit and timeout numbers of section 7: accepted?

## 9. Confirmation results (2026-11-02)

All 7 points were accepted: the endpoint split (evaluation on the command line, no audit API in phase 1); a one-shot JSON in phase 1 with a structure prepared for streaming; 404 for no access; `RAGETLAdmin` reading content limited by business role; the MCP tool list; MCP forwarding the user's JWT and checking `aud`; the rate-limit and timeout numbers.
