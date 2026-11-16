# Design document 09: phase 2 (P1) plan

[中文](09-phase2-plan.chn.md)

Status: **Draft, 2026-11-04**, based on the user's decisions on the [architecture diagram review table](../eval/architecture-review.html). The results of phase 1 (`v0.1.0`) are in [acceptance-v0.1.0.md](../eval/acceptance-v0.1.0.md). The concrete milestone checklists are written in [08](08-milestone-checklists.md) (from M9); this document only holds "what was decided, where it is scheduled, what is not done".

## 1. The user's decisions (2026-11-04)

| Item | Decision |
|---|---|
| The tail of M8: the 20% human spot check, `understand` asking too many clarifying questions, "no answer but still marked answered", Anthropic and fallback verification | **Do** (M9) |
| Streaming output | **Do** (M9). Uses "stream first, withdraw if verification fails" |
| Cost and latency statistics | **No version of our own**: Langfuse already computes cost per model and conversation (full profile). The lite profile has no Langfuse, so decide again when lite is built |
| Memory | Not for now; wait until the enterprise back office exists |
| Write action confirmation | Not for now; wait until the enterprise back office exists |
| Rate limiting in 3 dimensions | **Do** (M9): IP / user / token; the token dimension is set at no more than US$0.50 per day for the whole stack |
| LiteLLM multi-model fallback | **Do** (M9): `openai/gpt-6-luna` → `openai/gpt-4o-mini` → `anthropic/claude-haiku-5-5`; only verify that Haiku works, and do not run the full evaluation on it |
| A few items that are on the diagram but are neither in the requirements list nor planned | **Listed under phase 2** (section 3 of this document), **not scheduled yet** |

## 2. Scheduled

| Milestone | Content |
|---|---|
| M9 | The items marked "Do" above: the M8 tail, streaming output, three-dimension rate limiting, model fallback |

## 3. Candidates listed under phase 2 but not scheduled (from the architecture diagram)

The three items the user named:

| Item | Place on the diagram | Current state |
|---|---|---|
| Output guardrail: PII masking, sensitive words | ④ Guardrail post-check; ③ the PII masking of FastAPI | None. The output has no further filter |
| Jailbreak detection | ④ Guardrail pre-check | Only a prompt-injection check of a few regular expressions |
| MCP Resources (read-only data sources located by URI) | ⑤ MCP server | Tools only |

The other "not planned" items on the diagram are listed as candidates as well (scope to be confirmed by the user):

| Item | Place on the diagram |
|---|---|
| Analytics agent (data analysis, charts, reports) | ④ |
| Web search agent | ④ |
| Local vLLM (fallback for sensitive data) | ⑥ |
| Redis for sessions, a JWT blacklist, response cache, distributed locks, Pub/Sub | ⑦ |
| Vault secret management, Sentry error tracking | ⑧ |
| Edge reverse proxy (Nginx / Cloudflare), CDN + WAF | ② |
| PostgreSQL primary-replica and PITR backup | ⑦ |

## 4. Items that were already scheduled for later

| Item | Source |
|---|---|
| The enterprise back office (the NestJS business module): memory and write action confirmation wait for it | Sub-project 2 of the requirements document |
| The lite profile (Oracle k3s, Helm, the identity plan) | Section 6 of 07, section 3 of 06 |
| An Auditor role and an audit query endpoint | Section 2 of 03 |
| Franchised-campus data, Chinese-language data | Section 6 of 07 |
| The BM25 extension (evaluation says it is not needed for now) | Section 2.1 of 05 |
| Centralised logs with Loki | Section 6 of 06 |
| A summary of the conversation context (currently only the last 6 turns are kept) | Item C of the requirements list |
