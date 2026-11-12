# Business Module

The traditional business back office of StarEdu: a multi-tenant SaaS back office (accounts, roles and permissions, organization, people, teaching, assignments, grades, notifications, document library) built with NestJS, Prisma, Next.js 15, Tailwind and shadcn/ui-style components, with Keycloak for sign-in.

Status: **milestone B2 (authentication, roles and permissions, data scope).** Every request is bound to a tenant by its host name and isolation is enforced three times (request scope, Prisma extension, database row-level security) and checked by a cross-tenant leak scan (B1). On top of that, sign-in works end to end (Keycloak, one realm per tenant), the API checks a permission code on every endpoint, roles pick menus and buttons, and data scopes limit which rows a role can see or change. The admin console has a menu-tree shell with tabs and three working pages (online users, login log, audit log); the other pages arrive with their milestones.

## What is here

| Path | What |
|---|---|
| `apps/api` | NestJS API (port 4000). `GET /healthz` checks Postgres and Redis. |
| `apps/web` | Next.js app (port 3001), three entry points in one app: student portal `/`, admin console `/admin`, platform console (host `platform.*`, rewritten to `/platform`). English first, Chinese as a second language (cookie `locale`). |
| `packages/shared` | Shared code: tenant-code rules (reserved words) and the **Keycloak realm template** (all tunable parameters in `src/realm-config.json`). |
| `prisma/` | Prisma schema and migrations (`biz` schema), including hand-written SQL for row-level security, triggers and the low-privilege role `biz_app`. |
| `deploy/compose/biz.yaml` | Postgres, Redis, S3-compatible object storage, Keycloak, Mailpit. Separate Compose project from the AI module, with different ports. |
| `scripts/` | `dev-set-password.ts` (local only: set a password for a user so you can sign in without the invite email), `provision-tenant.ts` (open a tenant: Keycloak realm, headquarters campus, roles, built-in admin, invite email; safe to repeat), `seed.ts` (two demo tenants, `hq` and `franchise`), `create-realm.ts` (platform realm), `smoke-b0.ts` (end-to-end check of the realm template). |

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

Sign in to the admin console (local demo):

```bash
pnpm dev:password --code hq --username admin --password '<10+ characters, upper and lower case, digit, special character>'
# then open http://hq.localhost:3001/admin and sign in as "admin"
```

If you set up the local stack with an earlier milestone, run `make reset` and `pnpm seed` again so the realm template changes (logout redirect) and the new menu catalog and role templates are applied. `pnpm seed` also upgrades tenants that are already open: it adds missing menus and role templates.

`*.localhost` names resolve to your machine in most browsers; if yours does not, add them to `/etc/hosts`. Mailpit shows outgoing mail at http://localhost:8125. Keycloak admin is at http://localhost:8180.

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test   # tests include real Postgres and Redis (make up first)
pnpm test:leak                             # only the cross-tenant leak scan (reads, writes, foreign ids)
pnpm smoke                                 # creates a temporary tenant realm, checks token claims,
                                           # password policy, lockout and email delivery, then removes it
```

## How tenant isolation works

1. The tenant comes only from the **host name** (`hq.localhost`, `franchise.staredu.com`), never from anything the client sends. Unknown tenant: 404. Suspended: 403.
2. A token must be issued by **that tenant's Keycloak realm**; a token from another tenant's realm is rejected.
3. Every Prisma operation gets the tenant added automatically (`src/tenancy/`), and creating or changing another tenant's row is refused.
4. The database enforces it again: the app connects as `biz_app`, and row-level security shows it only rows of the tenant set for the current transaction (`app.tenant_id`). With no tenant set it sees nothing.

Prisma queries are lazy: they read the current tenant when they are awaited, so always `await` inside the request.

Foreign keys are **not** covered by row-level security (Postgres skips policies when it checks them), so any endpoint that accepts another record's id must first check that the id belongs to the current tenant. Use `assertVisible` (`src/tenancy/owned.ts`) and register the endpoint in `apps/api/test/leak/registry.ts`; a test fails for any route that is not registered.

## How permissions work

- **Keycloak says who you are; the API says what you may do.** A token must come from a known tenant realm (issuer allow-list, signature, audience, expiry), match the host's tenant, and belong to an active account whose session was not force-logged-out.
- **Every non-public endpoint declares a permission code** (`@RequirePermissions('module:resource:action')`, constants in `packages/shared/src/permissions.ts`) or explicitly `@AnyAuthenticated()`. An endpoint with neither is refused (fail closed).
- **The menu is the permission**: a role ticks menus and buttons; the permission codes on the ticked items are the role's operation permissions, limited to the features the platform enabled for the tenant. The platform-provided menu catalog is in `packages/shared/src/menu-catalog.ts` and is synced into the database when a tenant is opened (and by `pnpm seed`).
- **Built-in roles**: *tenant administrator* has every operation permission of the enabled admin features but no business data scope (only staff basic information); *student* is assigned automatically to student accounts. Neither can be changed or deleted.
- **Data scope**: a role also has data-scope sets (all, own department, own department and below, own records, own classes, or a custom pick of departments). Only roles that hold the endpoint's permission take part in that request's scope; several roles and sets are combined as a union; no applicable set means no rows. Endpoints build their row filter with `withScope` (`src/data-scope/`), and writes check the target row against the same scope.
- **Permission version**: changing roles, menus, data scopes or role assignments bumps a per-tenant counter in Redis, and cached permissions with an older version are reloaded, so a change applies on the next request. Anything that changes a person's departments must also call `AuthzService.bump`.
- Browsers never see tokens: the web app keeps them in a server-side session (Redis) behind an httpOnly cookie and forwards API calls through `/bff/*`.

## Ports (they differ from the AI module so both can run together)

Postgres 5433, Redis 6380, object store 9100/9101, Keycloak 8180, Mailpit SMTP 1125 and web 8125, API 4000, web 3001.

The synthetic company data in `../ai-module/sample-data/structured/` is meant to seed this module too, so both systems describe the same company.
