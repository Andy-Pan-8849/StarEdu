# StarEdu

An open-source blueprint for adding AI to a traditional business system. It pairs an enterprise back office with an AI knowledge assistant and agents, using one sample company, **StarIT Education** (an IT training company with eight campuses all around the country), as the running example.

| Module | Folder | Status |
|---|---|---|
| AI module: RAG, agents, API, web chat | [`ai-module/`](ai-module/) | Runs locally with Docker Compose |
| Business module: back office in TypeScript (open-source competitor style) | [`business-module/`](business-module/) | Not started |

## What the AI module does

- **Knowledge base.** Documents (md, txt, docx, pdf) are parsed, chunked, embedded and stored in PostgreSQL with pgvector.
- **Hybrid search.** Keyword and vector search fused with reciprocal rank fusion, then a model reranker. Role-based permissions are applied inside the database query, before ranking.
- **A permission-aware assistant** built with LangGraph. It asks a clarifying question only when needed, refuses out-of-scope or write requests, answers with citations, and verifies each answer against its sources. Data questions ("how many claims exceed the limit?") run through read-only SQL views and an MCP server, scoped to the asker.
- **Streaming answers** over Server-Sent Events. A draft that fails verification is withdrawn and replaced.
- **Operations.** A LiteLLM gateway with a model fallback chain (OpenAI, then Anthropic), per-user / per-IP rate limits, a daily cost budget, Keycloak login, an append-only audit log, and OpenTelemetry / Grafana / Langfuse (optional).
- **Evaluation.** 114 document questions, 41 data questions and a permission leak sweep, with reports in [`docs/eval/`](docs/eval/). Latest answer run: 107/114, and a human review of a 20% sample agreed with the model judge on 21 of 23 items.

## Quick start

Requirements: Docker Compose (8 GB of memory or more), [uv](https://docs.astral.sh/uv/), `make`, and an OpenAI API key.

```bash
git clone https://github.com/Andy-Pan-8849/StarEdu.git
cd StarEdu/ai-module
make env            # creates .env; set OPENAI_API_KEY in it
make sync && make up && make seed
```

Open <http://localhost:3000> and sign in as `wei.stu.sh` with the password `demo-pass-123` (a local demo account). See [`ai-module/README.md`](ai-module/README.md) for the details (in Chinese).

## Architecture

| Part | Technology |
|---|---|
| Front end | Next.js 15, Tailwind CSS |
| AI back end | FastAPI, LangGraph, MCP server |
| LLMs | OpenAI and Anthropic through LiteLLM |
| Database / queue | PostgreSQL + pgvector, Redis |
| Identity | Keycloak (OIDC) |
| Deployment | Docker Compose today; k3s planned for the server profile |

Design documents are in [`docs/design/`](docs/design/); what each milestone delivered is in [`docs/design/08-milestone-checklists.md`](docs/design/08-milestone-checklists.md).

## Repository layout

```
StarEdu/
├── ai-module/         the AI module (code, deployment files, sample data)
│   └── sample-data/   synthetic documents, tables and evaluation sets
├── business-module/   placeholder
└── docs/              design documents and evaluation reports
```

## Sample data

Everything in [`ai-module/sample-data/`](ai-module/sample-data/) is synthetic: the company, names, numbers, policies and URLs (`*.starit.example`) are invented. It includes 28 documents and 7 data tables, with deliberate retrieval challenges such as superseded policy versions, role-based access, exact identifiers and unanswerable questions.

## Roadmap

1. AI module: done through milestone M9. Next batch: see [`docs/design/09-phase2-plan.md`](docs/design/09-phase2-plan.md).
2. Business module (NestJS back office).
3. Deployment profiles (full and lite) and a public demo.
4. A Chinese version of the sample data.

## License

MIT, see [LICENSE](LICENSE).
