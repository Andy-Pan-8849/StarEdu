# StarEdu

A blueprint for small and mid-sized companies that want to add AI to a traditional business system. It pairs an enterprise back office with an AI knowledge assistant and agents, and uses one fictional company, **StarIT Education**, as the running example: an IT training company with eight campuses across China.

> **Project status.** The **AI module runs** (milestones M2 to M9: RAG pipeline, hybrid search, a permission-aware assistant with streaming answers, a data-question agent, LiteLLM gateway with model fallback, limits, observability, web app, evaluation). To start it, follow [`ai-module/README.md`](ai-module/README.md#quick-start-about-15-minutes-the-first-time). The business module is not started.

## Overview

The project has two modules that describe the same company:

| Module | Folder | What it is | Status |
|---|---|---|---|
| AI module | [`ai-module/`](ai-module/) | Enterprise knowledge assistant (RAG with hybrid search) and agents, exposed through a FastAPI service and a Next.js front end | Runs locally with Docker Compose (M2 to M9 done) |
| Business module | [`business-module/`](business-module/) | A traditional enterprise back office in the style of open-source competitor, rebuilt in TypeScript | Not started |

The goals are to show how the pieces fit together in a realistic business setting, and to give learners a codebase they can run, read and extend.

## Features

**Available now**

- A synthetic data set for the fictional company StarIT Education (see [Sample data](#sample-data)):
  - 28 documents in HR, Finance and Technical Support, in mixed formats (docx, pdf, md, txt)
  - 7 structured tables (campuses, employees, expense claims, support tickets, students, assignments, submissions)
  - 87 evaluation questions with expected answers
  - Deliberate retrieval challenges: superseded policy versions, role-based access, exact identifiers, paraphrases, multi-document reasoning, unanswerable questions

**AI module (runs today, see [`ai-module/README.md`](ai-module/README.md))**

- RAG pipeline with parsers for md, txt, docx and pdf; hybrid search (keyword + vector, RRF, reranking) with the permission filter inside the database query
- A LangGraph assistant: clarification, refusal, cited answers with a verification step, data questions through read-only SQL views and an MCP server, streaming answers that are withdrawn if they fail verification
- Role-based access through Keycloak, an append-only audit log, rate limits and a daily cost budget
- LiteLLM gateway with a model fallback chain (OpenAI, then Anthropic)
- OpenTelemetry, Prometheus, Grafana, Tempo and Langfuse (optional)
- An evaluation suite: 114 document questions, 41 data questions, permission leak sweeps

**Planned**

- Business module (NestJS back office)
- Two deployment profiles from one codebase: a **full** profile for local use and a **lite** profile for a small server (k3s)
- Second-phase AI features, see [`docs/design/09-phase2-plan.md`](docs/design/09-phase2-plan.md)

## Planned architecture

| Part | Technology |
|---|---|
| Front end | Next.js 15, Tailwind CSS, shadcn/ui |
| Business back end | NestJS, Prisma |
| AI back end | FastAPI, MCP server |
| LLMs | OpenAI and Anthropic through an LLM gateway (LiteLLM) |
| Embeddings | OpenAI `text-embedding-3-small` (configurable) |
| Database | PostgreSQL with pgvector |
| Cache and queues | Redis |
| Deployment | Docker Compose for development, k3s for the server |

Decisions that are still open (for example the identity service for the lite profile) are tracked by the maintainer and not listed here.

## Repository layout

```
StarEdu/
├── README.md
├── LICENSE
├── docs/
│   └── project-requirements.md   requirements and decision log
├── ai-module/
│   ├── README.md
│   └── sample-data/              synthetic documents, tables, evaluation sets, generators
└── business-module/
    └── README.md                 placeholder
```

## Getting started

```bash
git clone https://github.com/Andy-Pan-8849/StarEdu.git
cd StarEdu/ai-module
make env                  # then put OPENAI_API_KEY in .env
make sync && make up && make seed
```

Open <http://localhost:3000> and sign in as `wei.stu.sh` / `demo-pass-123`. The full guide (what to ask, how to check, how to run the evaluation) is in [`ai-module/README.md`](ai-module/README.md).

The sample-data generators (`ai-module/sample-data/tools/`) need only Python 3. `build_documents.py` writes docx files with the macOS `textutil` command and PDFs with headless Google Chrome, so it only works on a Mac with Chrome installed; the repository already contains the generated documents.

## Configuration (planned)

The application will read its settings from environment variables. Docker Compose will use a `.env` file (a `.env.example` will be provided and the real `.env` is git-ignored). The k3s deployment will use Helm values and Kubernetes Secrets with the same variable names.

The intended behavior for the public address of the apps:

1. If a domain is configured, use the domain.
2. Otherwise, if a public IP is configured, use the public IP.
3. Otherwise, run locally on `localhost` with separate ports.

You will be able to run everything locally without any domain. A free dynamic DNS name (for example from DuckDNS) is an optional extra for a public demo.

The embedding model is configurable by provider, model name and dimensions. Changing the model changes the vector size, so documents must be indexed again after a change.

## Sample data

Everything in [`ai-module/sample-data/`](ai-module/sample-data/) is **synthetic**. StarIT Education is fictional; names, numbers, policies, URLs (`*.starit.example`) and the tax ID are invented. The policies follow common practice in the IT training industry and do not describe any real company. The English data set comes first; a Chinese version is planned.

See the [sample-data README](ai-module/sample-data/README.md) for the file list, the built-in retrieval challenges, the access model (role-based for policy documents, data scope for campus data), the job levels and the demo accounts.

## Testing and validation

From `ai-module/`: `make lint`, `make test`, `make web-check` and `make e2e` are free. `make eval ARGS="answers"` (and `agent`, `data`, `all`) call real models, print the estimated cost first and ask before running. The latest answer run is 107/114; reports are in [`docs/eval/`](docs/eval/).

## Roadmap

1. AI module: done through M9; second-phase features are being chosen
3. Business module: enterprise back office in TypeScript
4. Deployment profiles and a public demo
5. Chinese version of the sample data

## License

MIT, see [LICENSE](LICENSE).
