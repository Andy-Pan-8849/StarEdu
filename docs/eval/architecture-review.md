# Architecture diagram review

[中文](架构图对照验收表.md)

The full comparison table is in a web page: **[architecture-review.html](architecture-review.html)** (a single file, open it directly in a browser; it has four views: by layer of the diagram, filtered by status, the requirements list A to H, the phase 2 P1 and later items, and the to-dos found this time). An earlier Markdown table had cells that were too long to compare side by side in most renderers, so it became a web page.

Date: 2026-11-04 (after `ai-m8` / `v0.1.0`). Basis: the reference architecture diagram `interview_arch_traditional_plus_ai_v2.png` (specified in section 3 of the requirements document; it is on the author's machine and not in the repository), the requirements list A to H and the P1 list (round 7 of `docs/project-requirements.md`), and every item marked "phase 2" and "later" in the design documents. The overall acceptance result is in [acceptance-v0.1.0.md](acceptance-v0.1.0.md).

## Conclusion

- **The phase 1 requirements list A to H has no real gaps**; 5 items were scaled back: the context is only truncated and not summarised, explicit denial is in the authentication layer, Loki, lite (k3s), the 20% human spot check.
- **Done differently from the diagram, but by deliberate decision**: a Postgres queue instead of Kafka, Postgres full text instead of Elasticsearch, views instead of RLS, LLM rerank instead of Cohere, conversation state in a table instead of a checkpointer, fixed replies instead of a model call for chit-chat, the original relayed by the api instead of a pre-signed URL.
- **On the diagram, but not in the requirements and not planned** (for you to decide whether to include them): output guardrails and PII masking, jailbreak detection, MCP Resources, the Analytics and Web Search agents, LLM fallback, Redis caching and blacklist, local vLLM, Vault and Sentry.
- **Configured but not verified by me**: the Anthropic model path.
- **The four formal P1 items**: streaming output (proposed to add), cost and latency statistics (proposed to add), memory (postpone), write action confirmation (postpone, wait for the enterprise back office).

## Meaning of the statuses

Done / done differently (by deliberate decision) / partly done / not done. Every "not done" carries a reason: decided at design time, scheduled for phase 2, outside the AI scope, not planned, not verified by me, not aligned with the diagram, scheduled separately.
