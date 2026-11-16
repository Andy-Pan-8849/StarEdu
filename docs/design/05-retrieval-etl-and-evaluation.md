# Design document 05: ingestion pipeline, search and evaluation plan (AI module, phase 1)

[中文](05-retrieval-etl-and-evaluation.chn.md)

Status: **Approved by the user (2026-11-02); the 7 confirmation points of section 5 were accepted, with keyword ranking following plan A (see below).** No application code is written before the other design documents are approved.
Depends on: 01 to 04. Marking convention: **[Decided]**, **[Proposed]**, **[Open]** (decided at implementation time by choosing or measuring).

## 1. Ingestion pipeline (ETL)

### 1.1 Stages

```
Upload → [parse] → [clean] → [chunk] → [derive (optional)] → [embed] → [write]
```

Each stage corresponds to `ingestion_jobs.stage`; on failure the stage and the reason are recorded, and the document management page can retry. The worker updates `stage` after each stage, and the write stage completes in **one transaction** (delete the old chunks first, then write the new chunks and vectors), so a failure midway leaves no half-finished result.

### 1.2 Pluggable parsers [Decided]

Interface (`core`):

```
Parser.parse(file) -> ParsedDocument(blocks=[Block(type, text, level, page)])
Block.type ∈ heading | paragraph | list_item | table | code
```

The parser is chosen by file extension, and the registry is extensible. **Candidate libraries** (chosen at implementation) [Open]:

| Format | Candidate | Notes |
|---|---|---|
| docx | python-docx | Keeps heading levels and tables |
| pdf | pdfplumber or pypdf | Avoid libraries under the AGPL license; the license of the open-source repository must be compatible with MIT |
| md / txt | markdown-it-py / read directly | md keeps headings and code blocks |

### 1.3 Cleaning

Remove repeated headers and footers, extra whitespace and invisible characters; **never rewrite the body text**. Tables are converted to Markdown table text.

### 1.4 Chunking [Proposed]

- Split by heading structure, keeping a section together where possible; a chunk targets 300 to 500 tokens with about 50 tokens of overlap between neighbours (counted with tiktoken), and all parameters can be changed in the `config` of an ingestion job.
- **Tables are kept whole or in row groups and never cut in the middle of a row; code blocks (including fenced code in md) are indivisible units** (the General chunker was found in the RAGFlow trial to lose md code fences).
- Each chunk stores `heading_path` and `page`; the text used for embedding is `heading_path + body`, while the stored `text` is the **pure original**.
- Codes (such as `ERR-PORTAL-403`, `FIN-PAY-004`, `TS-HW-006`) are extracted from the text by rules into `identifiers` and added to `tsv`.

### 1.5 Derived content (optional)

- Each ingestion job can switch on: a summary, hypothetical questions (3 to 5), keywords, written to `ai.chunk_derived`, **without replacing the original text** [Decided, see 02].
- A smaller model, versioned prompts; a failure does not stop ingestion (only the derived content is missing, and a warning is recorded).
- Its value must be proved by evaluation: compare the search metrics "with / without derived content" (see 4.3), and switch it off by default if the effect is not clear.

### 1.6 Embedding and writing

- Embeddings are called in batches, with the configured model and dimensions (`chunk_embeddings` in 02); a failed batch is retried, and the job fails after too many attempts.
- At write time the permissions, status and version of the document are copied to the chunks (the consistency rule of 02).
- The ingestion script for the sample data reads `manifest.csv`, expands `access` into `allowed_roles` with the expansion table of 2.3 of 02, and calls the same ingestion interface, so the sample and a real upload take the same path.

## 2. Search pipeline

### 2.1 Steps

```
standalone_query ──┬─▶ keyword search (after permission filter) top 30 ─┐
                   │                                                      ├─▶ RRF fusion ─▶ rerank ─▶ context assembly
                   └─▶ vector search (after permission filter) top 30 ───┘
```

1. **Permission and version filter**: the shared condition of section 4 of 02, placed in the `WHERE` of both searches, so filtering comes before ranking.
2. **Keyword search**: Postgres full-text search ranked by `ts_rank_cd`; chunks with an exact `identifiers` hit are boosted. Note that Postgres's own ranking **is not BM25**. **[Decided, plan A]** `ts_rank_cd` is the default, `core` defines a `KeywordSearcher` interface, and a BM25 extension is a switchable second implementation; whether to bring it in is decided by the "keyword ranking" comparison of the evaluation. A BM25 extension needs a self-built Postgres image (the ready-made pgvector image does not contain it), and its license, arm64 build and version compatibility must be verified before the evaluation; none of that has been checked yet.
3. **Vector search**: cosine distance, exact scan (2.4 of 02).
4. **RRF fusion**: `score = Σ 1 / (k + rank)`, `k = 60`.
5. **Rerank**: rerank the top 20 candidates after fusion and keep the top 6.
6. **Context assembly**: deduplicate; neighbouring chunks of the same document may be merged; the total stays within the context budget (about 3500 tokens); every chunk carries `doc_code`, `version`, `status` and `heading_path` so the generation stage can label citations and versions.

All the numbers (30 / 30 / 60 / 20 / 6 / 3500) are configuration items and tunable parameters during evaluation.

### 2.2 Rerank options [Proposed]

`Reranker` is a pluggable interface, all built together in phase 1 (confirmed):

| Implementation | Pros | Cons |
|---|---|---|
| **LLM listwise rerank (default)**: a smaller model scores and orders the 20 candidates | No new vendor or key; usable in lite too | One more LLM call, adding latency and cost; counts against the LLM call budget of 04 |
| A dedicated rerank API (such as the rerank endpoints of Cohere or Voyage) | Low latency, usually steadier results | Needs a new vendor key and billing |
| A local cross-encoder model | No call cost | Uses memory, not suitable for the lite deployment |

The first is the default and the interface leaves room for the other two. Whether to switch to a dedicated reranker is decided by the "with / without rerank" comparison of the evaluation and the latency data.

### 2.3 The threshold of `grade_retrieval`

The top score after rerank and the number of hits are used to judge "enough"; the threshold is not guessed but **calibrated with the evaluation set** (comparing the score distribution of `unanswerable` questions with that of answerable ones): an initial value first, adjusted after evaluation [Open].

### 2.4 Switchable search modes

The configuration item `retrieval_mode`: `keyword`, `vector`, `hybrid`, `hybrid_rerank` (default). They are run one by one during evaluation, to **verify and show the value of hybrid search**, one of the learning goals of the project.

## 3. Data queries (SQL / MCP)

Permissions, views and session variables are in section 5 of 02, and the flow in 04. For SQL questions the evaluation only checks whether the result is correct and whether it overreaches; it does not involve the search pipeline.

## 4. Evaluation plan

### 4.1 State of the data sets (checked)

| Data set | Count | Composition |
|---|---|---|
| `qa-set.jsonl` | 54 | Types: single 31, multi 7, access 7, keyword 3, unanswerable 3, version 2, paraphrase 1; asking roles: staff 35, student 15, finance 2, manager 1, hr 1; `should_answer = false` on 6 |
| `sql-qa.jsonl` | 33 (M2.0 revision) | Each question names the asking account and the data scope: 26 should be answered (whole company 16, own campus 7, own records 3), 7 overreaching ones should be refused (see `sample-data/README.md`) |

**Problem**: the `keyword`, `version`, `paraphrase` and `unanswerable` types have too few questions, and so do the `manager` and `hr` roles, which is not enough for reliable conclusions. **It is proposed to add more after the evaluation runner is done** (at least 8 to 10 per type, and for every restricted document a pair of questions, "allowed / not allowed"); the additions are synthetic data too. [Proposed]

### 4.2 Test identities

Preset in Keycloak (passwords for local use and demos only): at least one account per business role, plus campus accounts: a Beijing staff, a Shanghai staff, a Shanghai manager; one `Admin` and one `RAGETLAdmin` (to verify the least privilege of 01: `Admin` cannot reach restricted content). The evaluation runner can **call `core` directly with a synthetic identity** (without the sign-in page), while a few end-to-end cases with a real JWT are kept.

### 4.3 Metrics

| Category | Metric | How it is judged |
|---|---|---|
| Search | `recall@k` (are all `source_docs` in the top k results), MRR | Deterministic computation, no LLM needed |
| Answer correctness | Scored against `expected_answer` | Numbers and codes compared deterministically; the rest by an LLM judge, **with a 20% human spot check** to calibrate |
| Refusal correctness | For questions with `should_answer = false`: `end_state` is one of `no_permission` / `not_found` / `refused` and the answer contains no restricted fact | Deterministic + the key fact does not appear |
| **Permission regression** | For every restricted document, ask as **every role not allowed** and check that this run's search results contain **no** chunk of the document | Deterministic, **zero tolerance: any leak is a failure** |
| SQL | The result matches `expected_answer` after normalisation; overreaching access is refused | Deterministic |
| End state | Every run has a valid `end_state` / `end_reason` | Deterministic |
| Run metrics | Latency p50 / p95, tokens, estimated cost | From `ai.runs` |

Permission regression is the **gate that must fully pass in phase 1**; accuracy and the other metrics first build a baseline and then get a target, **with no numbers promised in advance**.

### 4.4 Experiment matrix (for learning and showing)

| Experiment | Comparison |
|---|---|
| Search mode | `keyword` / `vector` / `hybrid` / `hybrid_rerank` |
| Derived content | none / summary / hypothetical questions / all |
| Chunk size | 300 / 500 / 800 tokens |
| Rerank implementation | LLM listwise / dedicated API (if connected) |
| Code queries | `identifiers` boost on or off |
| Keyword ranking | `ts_rank_cd` / BM25 extension (if verified usable) |

Each evaluation run is written to `ai.eval_runs` (with the git commit and the whole configuration) and `ai.eval_results`, so runs can be compared side by side. The results are also summarised in a report under `docs/` and compared with the conclusions of the earlier RAGFlow trial.

### 4.5 How to run

- Command line: `uv run starit-eval --mode hybrid_rerank --roles all`, which writes a JSON and a Markdown report.
- One run costs real LLM calls, so the command line first prints the **estimated number of calls** and only starts after confirmation (a parameter can skip the confirmation).
- Unit and scenario tests (section 10 of 04) use a fake LLM, cost nothing and run every time in normal development; evaluations with a real LLM are triggered by hand.

### 4.6 The search challenges already buried in the sample data and the mechanism for each

| Challenge | Mechanism |
|---|---|
| Superseded policy versions (`superseded`) | Old versions take part in search labelled with status, generation rule 3 |
| Exact codes (such as `ERR-PORTAL-403`) | The `identifiers` field boost + the full-text index keeps the original text |
| Paraphrased questions | Vector search + hypothetical questions (if evaluation shows they work) |
| Multi-document reasoning | Context assembly merges several sources + generation rule 5, decide the range first |
| Role access | Permission filter + permission regression test |
| Unanswerable questions | The `grade_retrieval` threshold + `not_found` |

## 5. Points for you to confirm

1. The chunking strategy of 1.4 (by heading, 300 to 500 tokens, tables and code blocks not split, the embedded text carries the heading path): accepted?
2. Derived content in 1.5 is **optional**, with evaluation deciding whether it is on by default: accepted?
3. The search steps and default parameters of 2.1: accepted? Postgres's `ts_rank_cd` is not BM25; use it first and decide on a BM25 extension after evaluation: accepted?
4. Rerank in 2.2 defaults to the LLM listwise rerank (no new vendor), with the interface leaving room for a dedicated API: accepted?
5. The type distribution of the evaluation set in 4.1 is thin, and more questions (synthetic) are added after the runner is done: accepted?
6. The metric system of 4.3, especially "permission regression zero tolerance, the other metrics build a baseline first and then set targets": accepted?
7. Real LLM evaluation needs a look at the estimate and a confirmation first (4.5): accepted?

## 6. Confirmation results (2026-11-02)

All 7 points were accepted. On point 3, **plan A** was chosen: `ts_rank_cd` by default, BM25 as an optional implementation through the `KeywordSearcher` interface, with evaluation deciding whether to bring it in.

## 7. M3 implementation record (2026-11-03)

- **Parsing**: md (markdown-it-py), txt (rules), docx (python-docx, by heading style, with "bold and starting with a number" as the fallback when there are no styles), pdf (pdfplumber, headings found by font size, tables recognised separately). All four formats drop the metadata block that duplicates `manifest.csv`; tables are output uniformly as Markdown table text.
- **The sample docx files were regenerated**: the original docx files were converted by macOS `textutil`, with no heading styles and with tables flattened into ordinary paragraphs. The docx part of `build_documents.py` now uses python-docx, with the same content.
- **Checking the parsing**: for the 28 samples, the number of headings, chapters, sections and tables in all four formats matches the Markdown source exactly; every line of text of the source appears in the parsing result; every code in the source is fully kept.
- **A problem found and fixed**: in pdf, codes such as `FIN-TAX-008` break at the hyphen at a line end and were joined as `FIN- TAX-008`, which broke exact matching; the parser now joins a trailing hyphen directly to the next line.
- **Chunking**: split by heading structure; **the sample documents are very short** (splitting by section gives 189 chunks with a median of only 50 tokens), so a "target size" was implemented: a section boundary only breaks once the current chunk has reached `chunk_target_tokens` (default 400), short sections are merged, and the 28 documents give 39 chunks (median 358, maximum 453, limit 500). `chunk_target_tokens = 0` means one chunk per section. The two settings are an experiment item of "chunk size" in the M4 evaluation matrix.
- **Derived content** (summary, questions, keywords): the stage is reserved, not generated by default, and implemented once evaluation shows it helps.
- **The identifiers field**: `identifiers` records hyphenated codes and long alphanumeric codes, and also adds the document's own `doc_code`, so exact hits are possible in the full-text index.
- **Embedding**: the litellm library, with model and dimensions set by `EMBEDDING_PROVIDER` / `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` (consistent with design 06, without the `STARIT_` prefix); the vector column is 1536-dimensional, and a job fails at once if the configured dimension differs; the embedding input is "document title + section path + body".
- **Queue and retries**: `FOR UPDATE SKIP LOCKED`; after a failure it backs off 30 seconds, 2 minutes, 10 minutes, at most 3 attempts; failures such as a broken file, a dimension mismatch or no text are not retried; stalled jobs (a killed worker) are put back in the queue. The write stage replaces the old chunks in one transaction, and the old chunks stay as they were on failure.

## 8. M4 implementation record (2026-11-03)

- **Entry**: `starit_core.retrieval.retrieve(conn, identity, query, mode=...)`, which must carry an identity; four modes `keyword`, `vector`, `hybrid`, `hybrid_rerank`; the parameters are all in configuration (the defaults of 2.1 of design 05).
- **Keyword**: the AND of `plainto_tsquery` is replaced with OR (a question has many function words and AND finds almost nothing), ranked by `ts_rank_cd`; when the question contains a code, chunks that list that code get a boost (an `identifiers` hit), and **chunks belonging to the named document itself get one more share**, so "what does FIN-REIM-002 say" returns that document first and not another document that only mentions it in its body (a problem found in testing).
- **Vector**: cosine distance, exact scan; only compared with vectors from the same model.
- **Fusion**: RRF, `k = 60`. RRF looks only at rank, not at score, so **when the vector side and the keyword side disagree, the one exact hit can be pushed down** (`ERR-PORTAL-429` in the baseline is an example). For now rerank fixes it; if rerank is not used later, giving exact code hits priority after fusion could be considered.
- **Rerank**: `LLMReranker`, the chat model `openai/gpt-6-luna` (`STARIT_MODEL_RERANK`); the prompt asks for a JSON ranking, parsed tolerantly (code fences, missing numbers appended at the end, duplicate and out-of-range numbers ignored); if the model errors or the output cannot be parsed it keeps the fusion order and marks `rerank_failed`. The chat client sets `temperature = 0` and `reasoning_effort = "none"` for `gpt-6-luna` (this model only accepts `temperature = 1` when reasoning is on); models that do not support these parameters ignore them through `drop_params`.
- **Context assembly**: deduplicate (by chunk and by text), take the top `final_k`, stay within the token budget (keeping at least the first).
- **Probe**: `probe_restricted` is the only query without the permission filter and returns only numbers (the count and top score of filtered strong matches) and no text, and it does not enter the prompt; it serves audit and the `no_permission` / `not_found` distinction.
- **Evaluation runner**: `eval/` (`starit-eval`). Every real run first prints the number of calls, tokens and the estimated cost and asks; it writes `ai.eval_runs` / `ai.eval_results` (one run per mode) and the reports under `docs/eval/`; `--leak-sweep` does the permission regression for all roles; `--dry-run` rehearses the whole flow with a fake model.
- **Baseline results and their reading** are in [`docs/eval/README.md`](../eval/README.md).

## 9. M8 implementation record (2026-11-04)

- **Evaluation questions** grew from 54 to 114 (synthetic, written by me after reading the documents): keyword 13, paraphrase 11, version 10, unanswerable 12, access 26 (including one each for Admin and RAGETLAdmin), single 35, multi 7; manager 10, hr 5, finance 6. Every answerable question carries `facts` (the numbers, codes or words the answer must contain), and `sample-data/tools/check_qa_facts.py` proves that every fact really appears in the source document (tests and CI both run it). Every restricted document (HR-REC-002, FIN-PAY-005, FIN-BUD-007, TS-IT-010) has at least one question from a forbidden role. **The sample is still very small**, and even after the additions no conclusion about accuracy is drawn.
- **Answer scoring** (`starit-eval answers`): for questions that should be refused, the end state must be `no_permission`/`not_found`/`refused` and the citations must not contain that restricted document; for questions that should be answered, the end state must be `answered`, those with `facts` are compared deterministically (comma-separated numbers count as the same, and a `v` prefix on a version number is tolerated), and those without `facts` are judged by the model judge against the reference answer; the (state, reason) of every run must be valid. **A random 20% is exported as a CSV (fixed seed, reproducible) for human checking, and until it is checked the judge's conclusion is not taken as fact.**
- **`starit-eval all`** merges search (4 modes + the permission sweep), answers and data questions into one report; **permission regression is the gate**: any overreach fails the whole run (exit code 2). Runs are written to `ai.eval_runs` / `ai.eval_results`.
- **Derived content** (`ingest/derive.py`): one model call per chunk, producing a one-sentence summary and 3 "questions this chunk can answer"; written to `ai.chunk_derived` and **appended to the embedded text** (not replacing the original). It strengthens only the vector side, and the keyword side does not use it. If the model fails only that chunk's derived content is lost and the document is ingested as usual. Off by default (`STARIT_INGEST_DERIVE=none`).
- **The `identifiers` boost switch** (`STARIT_RETRIEVAL_IDENTIFIER_BOOST`, on by default). When off, a code in the question neither adds score nor makes a chunk a candidate unconditionally.
- **Experiment matrix** (`starit-eval matrix`): each experiment re-ingests the sample documents into a **temporary database** (the development database is unaffected) and searches in the keyword / vector / hybrid modes; rerank is not included (it is tested in the full evaluation). Not done: the dedicated rerank interface (not connected), the BM25 extension (not installed and not verified; decision: not brought in in phase 1). The results and how to read them are in `docs/eval/README.md`.
