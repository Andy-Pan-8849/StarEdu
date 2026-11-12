# Business Module

The traditional business back office of StarEdu: a multi-tenant SaaS back office (accounts, roles and permissions, organization, people, teaching, assignments, grades, notifications, document library) built with NestJS, Prisma, Next.js 15, Tailwind and shadcn/ui-style components, with Keycloak for sign-in.

Status: **milestone B1 (data model and tenant isolation).** Tenants, accounts, people, organization, roles, menus and entries exist as tables; every request is bound to a tenant by its host name; isolation is enforced three times (request scope, Prisma extension, database row-level security) and checked by a cross-tenant leak scan. Sign-in screens, roles and permissions come in B2.

## What is here

| Path | What |
|---|---|
| `apps/api` | NestJS API (port 4000). `GET /healthz` checks Postgres and Redis. |
| `apps/web` | Next.js app (port 3001), three entry points in one app: student portal `/`, admin console `/admin`, platform console (host `platform.*`, rewritten to `/platform`). English first, Chinese as a second language (cookie `locale`). |
| `packages/shared` | Shared code: tenant-code rules (reserved words) and the **Keycloak realm template** (all tunable parameters in `src/realm-config.json`). |
| `prisma/` | Prisma schema and migrations (`biz` schema), including hand-written SQL for row-level security, triggers and the low-privilege role `biz_app`. |
| `deploy/compose/biz.yaml` | Postgres, Redis, S3-compatible object storage, Keycloak, Mailpit. Separate Compose project from the AI module, with different ports. |
| `scripts/` | `provision-tenant.ts` (open a tenant: Keycloak realm, headquarters campus, roles, built-in admin, invite email; safe to repeat), `seed.ts` (two demo tenants, `hq` and `franchise`), `create-realm.ts` (platform realm), `smoke-b0.ts` (end-to-end check of the realm template). |

## Run it

Requires Node 20.19+, pnpm 10, Docker.

```bash
cd business-module
cp .env.example .env        # defaults are for local demos only
pnpm install
make up                     # Postgres, Redis, object store, Keycloak, Mailpit
pnpm migrate                # apply Prisma migrations
pnpm realm                  # create the platform realm from the template
pnpm seed                   # open two demo tenants: hq and franchise (safe to repeat)
pnpm dev:api                # http://localhost:4000/healthz
pnpm dev:web                # http://hq.localhost:3001  (and platform.localhost:3001)
```

`*.localhost` names resolve to your machine in most browsers; if yours does not, add them to `/etc/hosts`. Mailpit shows outgoing mail at http://localhost:8125. Keycloak admin is at http://localhost:8180.

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test   # tests include real Postgres and Redis (make up first)
pnpm smoke                                 # creates a temporary tenant realm, checks token claims,
                                           # password policy, lockout and email delivery, then removes it
```

## How tenant isolation works

1. The tenant comes only from the **host name** (`hq.localhost`, `franchise.staredu.com`), never from anything the client sends. Unknown tenant: 404. Suspended: 403.
2. A token must be issued by **that tenant's Keycloak realm**; a token from another tenant's realm is rejected.
3. Every Prisma operation gets the tenant added automatically (`src/tenancy/`), and creating or changing another tenant's row is refused.
4. The database enforces it again: the app connects as `biz_app`, and row-level security shows it only rows of the tenant set for the current transaction (`app.tenant_id`). With no tenant set it sees nothing.

Prisma queries are lazy: they read the current tenant when they are awaited, so always `await` inside the request.

## Ports (they differ from the AI module so both can run together)

Postgres 5433, Redis 6380, object store 9100/9101, Keycloak 8180, Mailpit SMTP 1125 and web 8125, API 4000, web 3001.

The synthetic company data in `../ai-module/sample-data/structured/` is meant to seed this module too, so both systems describe the same company.
