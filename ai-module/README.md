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
