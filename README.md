# StarEdu

A blueprint for small and mid-sized companies that want to add AI to a traditional business system. It pairs an enterprise back office with an AI knowledge assistant and agents, and uses one fictional company, **StarIT Education**, as the running example: an IT training company with eight campuses across China.

> **Project status: early stage.** The sample data and the design are done. The application code (RAG pipeline, agents, web apps) has **not been written yet**. Sections marked *Planned* describe the intended design, not something you can run today.

## Overview

The project has two modules that describe the same company:

| Module | Folder | What it is | Status |
|---|---|---|---|
| AI module | [`ai-module/`](ai-module/) | Enterprise knowledge assistant (RAG with hybrid search) and agents, exposed through a FastAPI service and a Next.js front end | Sample data done, code planned |
| Business module | [`business-module/`](business-module/) | A traditional enterprise back office in the style of open-source competitor, rebuilt in TypeScript | Not started |

The goals are to show how the pieces fit together in a realistic business setting, and to give learners a codebase they can run, read and extend.

## Features

**Available now**

- A synthetic data set for the fictional company StarIT Education (see [Sample data](#sample-data)):
  - 28 documents in HR, Finance and Technical Support, in mixed formats (docx, pdf, md, txt)
  - 7 structured tables (campuses, employees, expense claims, support tickets, students, assignments, submissions)
  - 87 evaluation questions with expected answers
  - Deliberate retrieval challenges: superseded policy versions, role-based access, exact identifiers, paraphrases, multi-document reasoning, unanswerable questions

**Planned**

- RAG pipeline with pluggable parsers (parse, clean, chunk, embed, store in pgvector)
- Hybrid search: keyword search plus vector search, fused with reciprocal rank fusion, then reranking
- Agents with tool use through an MCP server, guardrails, and read-only SQL access
- Role-based access to documents
- Two deployment profiles from one codebase: a **full** profile for local use and a **lite** profile for a small server
- Observability: Prometheus, Grafana, Loki, Tempo and OpenTelemetry

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

Right now the only runnable parts are the sample-data generators. They need Python 3 and nothing else.

```bash
git clone https://github.com/Andy-Pan-8849/StarEdu.git
cd StarEdu/ai-module/sample-data

python3 tools/generate_structured.py   # regenerates the CSV tables and the SQL evaluation set
python3 tools/build_documents.py       # rebuilds the documents from the Markdown sources
```

`build_documents.py` writes docx files with the macOS `textutil` command and PDFs with headless Google Chrome, so it only works on a Mac with Chrome installed. On other systems, change the `format:` of each source file in `_markdown-source/` to `md` or `txt`. The repository already contains the generated documents, so you do not need to run it to use the data.

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

Today you can check the data, not the application:

1. **The generator is reproducible.** Run `python3 tools/generate_structured.py` and then `git status`. A clean working tree means the committed tables match the generator.
2. **The documents match the manifest.** `documents/manifest.csv` lists all 28 documents with their version, status and access level.
3. **The evaluation sets are consistent.** Every `source_docs` entry in `eval/qa-set.jsonl` is a `doc_id` in the manifest, and the answers in `eval/sql-qa.jsonl` are computed by the generator from the CSV tables.

When the application exists, the evaluation sets will be used to measure answer quality, compare keyword, vector and hybrid search, and check that role-based access works.

## Roadmap

1. AI module: RAG pipeline, hybrid search, agents, API and chat front end
2. Observability for the AI module
3. Business module: enterprise back office in TypeScript
4. Deployment profiles and a public demo
5. Chinese version of the sample data

## License

MIT, see [LICENSE](LICENSE).
