# AI Module

Enterprise knowledge assistant and Agent application for the fictional company StarIT Education.

Status: **no application code yet.** Only the sample data exists. See the top-level [README](../README.md) for the decisions made so far.

Planned content (proposal, not yet approved):

- RAG ETL pipeline: pluggable parsers, cleaning, chunking, embeddings, pgvector.
- Hybrid search: keyword search plus vector search, fused with RRF, then reranking.
- Agents: router, RAG agent, SQL agent, action agent, guardrails, MCP server.
- FastAPI service with streaming chat, Next.js front end.

Folders:

| Folder | Purpose |
|---|---|
| `sample-data/` | Synthetic company documents, structured data and evaluation questions |

## Development setup (milestone M0)

Prerequisites: [uv](https://docs.astral.sh/uv/), Docker with Compose, and `make`. Python 3.12 is pinned in `.python-version`; uv installs it if needed.

```bash
cd ai-module
make sync      # install dependencies
make up        # start Postgres (pgvector), Redis, object storage and the API
make migrate   # apply database migrations
make test      # unit tests, plus integration tests when the services are up
make lint      # ruff and mypy
curl http://localhost:8000/healthz
```

The services use the usual default ports (Postgres 5432, Redis 6379, object storage 9000/9001, API 8000). If one is taken on your machine, change it in `.env` (created from `.env.example` by `make up`). `make down` stops the services and keeps the data; `make clean` also deletes the data volumes.

The design documents are in [`../docs/design/`](../docs/design/).
