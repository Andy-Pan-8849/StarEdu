<p align="center">
  <img src="assets/logo/logo.svg" alt="StarIT Education logo: a lighthouse sending its beams toward an arc of stars" width="160">
</p>

# StarEdu

[中文](README.chn.md) · **[Start here: TRY-IT.md](TRY-IT.md)** (set up Docker, run it, accounts to sign in with)

An open-source blueprint for adding AI to a traditional business system. It pairs a **multi-tenant back office** for a training company with an **AI knowledge assistant** (RAG and agents), using one sample company, **StarIT Education** (an IT training company with eight campuses), as the running example. The assistant can answer from the back office's own data, signed in as the same person, and sees only what that person may see.

## The two parts

| Part | What it is | Needs | Guide |
|---|---|---|---|
| **Business module** ([`business-module/`](business-module/)) | A multi-tenant SaaS back office: people, teaching and enrollment, assignments and grades, transcripts, notifications, a document library. Three entries: student portal, admin console, platform console. Demo companies and accounts included. NestJS, Prisma, PostgreSQL, Next.js 15, Keycloak. | Docker, Node.js 20.19+, pnpm 10. **No API key.** | [overview](business-module/README.md) · [try it](business-module/TRY-IT.md) |
| **AI module** ([`ai-module/`](ai-module/)) | A permission-aware knowledge assistant: documents and data questions answered with citations, filtered by who is asking. FastAPI, LangGraph, PostgreSQL + pgvector, MCP, LiteLLM. | Docker, uv, make, an OpenAI API key | [guide](ai-module/README.md) |
| **Both together** | The assistant opens from the back office ("AI assistant" menu), uses the company's own sign-in, and asks the back office what that person may read. | Both of the above | [Path C in TRY-IT](TRY-IT.md#5-path-c-both-together) |

## Run it in a few minutes

Read [TRY-IT.md](TRY-IT.md): it covers what to install, how to give Docker enough memory, the commands for each part, and which demo accounts to use. In short, the quickest way to see something is the business module (free, no key):

```bash
cd business-module
cp .env.example .env && pnpm install
make up && pnpm migrate && pnpm realm && pnpm demo
pnpm dev:api        # one terminal
pnpm dev:web        # another terminal
```

Then open <http://hq.localhost:3001> and click a demo account on the sign-in page.

## Where to read what

| Looking for | Go to |
|---|---|
| How to run it, accounts, reset, troubleshooting | [`TRY-IT.md`](TRY-IT.md) |
| What the business module does and how it is built (tenant isolation, permissions, addresses) | [`business-module/README.md`](business-module/README.md) |
| What the AI module does, how a question is routed, how to test it, code layout | [`ai-module/README.md`](ai-module/README.md) |
| What to click as each role in the back office | [`business-module/TRY-IT.md`](business-module/TRY-IT.md) |
| Hosting a public trial site | [`business-module/deploy/trial/README.md`](business-module/deploy/trial/README.md) |
| Requirements, design documents, evaluation reports | [`docs/`](docs/) ([requirements](docs/project-requirements.md), [design](docs/design/), [evaluation](docs/eval/)) |

## Repository layout

```
StarEdu/
├── README.md, TRY-IT.md     this overview and the single place to start (README.chn.md, TRY-IT.chn.md in Chinese)
├── business-module/         the multi-tenant back office (pnpm workspace: apps/api, apps/web, packages/shared)
├── ai-module/               the AI module (uv workspace: packages/core, apps/api, worker, mcp-server, web, eval)
├── docs/                    requirements, design documents and evaluation reports
├── assets/logo/             brand logo
└── LICENSE                  MIT
```

The detailed folder trees are in each module's own README.

## Status

1. AI module: done through milestone M9 (see the [phase 2 plan](docs/design/09-phase2-plan.md) for what is next).
2. Business module: done through milestone B31, with demo data and a hosted-trial mode.
3. Next: deployment to a public server (full and lite profiles) and a public demo.
4. Later: a Chinese version of the sample data.

All sample data is synthetic: the company, names, numbers, policies and URLs (`*.starit.example`) are invented.

## License

MIT, see [LICENSE](LICENSE).
