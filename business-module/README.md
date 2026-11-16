# StarEdu Business Module

[中文说明](README.chn.md) · **[Try it: setup, trial data, accounts](TRY-IT.md)** ([中文](TRY-IT.chn.md))

The traditional business system of StarEdu: a **multi-tenant SaaS back office for a training or education company**. It manages organizations and people, teaching and enrollment, assignments and grades, transcripts, notifications and a document library, and it is the system the [AI module](../ai-module/) plugs into. It is built as an open-source reference: the interesting part is not any single screen but the way tenant isolation, permissions, data scope, auditing and testing are done end to end.

Built with NestJS, Prisma and PostgreSQL on the server, Next.js 15 with Tailwind and shadcn/ui-style components in the browser, and Keycloak for sign-in. English first, Chinese as a second language.

## What it does

**Platform (for the operator running the SaaS)**
- Open, edit, notify, suspend and restore companies (tenants); switch features on or off per company.
- Per-company sign-in and security settings (password rules, lockout, session time, two-step verification, optional Google sign-in), usage and quota (accounts, storage), scheduled jobs with run logs, platform announcements, monitoring, platform accounts and roles.

**Company administration**
- Campuses, departments (a tree), posts, accounts (invitation, reset link, temporary password, unlock), roles built from menus and buttons, data-scope sets, menus and entry assignment, dictionaries, parameters.
- Operation log, login log, audit log, online users with force logout.
- Roles created from platform templates can be brought up to date when a template gains menus (preview, then add only what is missing).

**People (HR)**
- One person record with an optional staff profile and an optional student profile; assignments with history (primary and secondary, transfers), planned or immediate end of employment.
- Two layers of data: basic information versus sensitive information and emergency contacts (not even visible to the built-in administrator).
- CSV import and export that can be repeated safely.

**Teaching**
- Terms, courses with prerequisites, majors with **curriculum versions by entry year**, sections (a course in a term on a campus) with instructors and a schedule.
- Enrollment by students and by the academic office under the same rules (capacity under a row lock, prerequisites, schedule clashes, windows); the office can confirm exceptions with a reason. **Batch enrollment** by major, entry year and campus with a preview.
- Dropping (voided before the deadline, "W" after), course materials, discussions per section.

**Assignments and grades**
- Assignments with rubrics, groups, deadlines at 23:59 campus time, late-work penalty tables, per-student extensions, multi-file submissions uploaded straight to object storage with version history.
- Scoring per rubric item, scores visible only after publishing, grade book with manual scores, weighted final grades, publishing, locking at the end of the section, and amendments with a reason and a before/after record.
- GPA by term and cumulative, a company grading scale, retakes, a dashboard limited to what the viewer's data scope allows.

**Transcripts and student requests**
- Numbered unofficial and official transcript PDFs with a watermark, a QR code and a content fingerprint; a public verification page per document; revocation.
- Students can request a grade re-check or an assignment extension and withdraw while pending; instructors and the academic office approve or reject with a note, everything is audited and the student is notified.

**Communication and documents**
- Notifications by event: in-app, pushed live over WebSocket, and queued as e-mail in English or Chinese, with per-category switches and unsubscribe links; announcements to the company, a campus or a section.
- A company document library with public, internal and confidential folders, access levels, expiring grants, versions, view-only and watermarked viewing, and an access log for confidential material.

**AI integration**
- The AI assistant can run in *business mode*: it signs in with the company's realm, asks this module which rows and folders the person may see, and reads the database only through read-only views filtered by those scopes.

**For developers**
- `pnpm gen:module` scaffolds a plain tenant resource (table with row-level security, API, permissions, menu, page, tests, leak-scan entries).
- A demo mode with a living scenario, demo accounts on the login pages and a one-command reset (see [TRY-IT.md](TRY-IT.md)).

## How it is built (conventions you will recognize)

### Multi-tenancy: three independent walls
1. The tenant comes **only from the host name** (`hq.localhost`, `school.example.com`); never from anything the client sends. Unknown tenant: 404. Suspended: 403.
2. A token must be issued by **that tenant's own Keycloak realm** (one realm per tenant).
3. Every Prisma operation gets the tenant added by an extension, and writing another tenant's row is refused.
4. The database enforces it again: the application connects as a low-privilege role and **row-level security** shows it only rows of the tenant set for the current transaction. With no tenant set it sees nothing.

Foreign keys are not covered by row-level security, so any endpoint that accepts another record's id first checks that the id belongs to the current tenant, and is registered in the **cross-tenant leak scan**, which fails for any route that is not registered.

### Identity and permissions
- **Keycloak says who you are; the API says what you may do.** Browsers never hold tokens: the web app keeps them in a server-side session behind an httpOnly cookie and forwards calls through a backend-for-frontend (`/bff/*`) that also requires a custom header on writes.
- Every non-public endpoint declares a permission code (`module:resource:action`) or is refused (fail closed). **The menu is the permission**: a role ticks menus and buttons; the codes on them are its operation permissions, limited to the features enabled for the tenant.
- **Data scope** limits rows: all, own department, own department and below, own records, own classes, or a custom pick; several roles combine as a union; no scope means no rows. Endpoints build their filter with one helper, and writes check the target row against the same scope.
- Changing roles or assignments bumps a per-tenant version, so cached permissions refresh on the next request. You cannot grant a permission you do not hold (anti-escalation).
- Built-in roles (tenant administrator, student) cannot be changed; the administrator has every operation permission but no business data scope, by design (separation of duties).

### API and data
- REST with schema validation (zod) at the boundary, strict objects, explicit error codes for business refusals, and an audit entry for every change.
- Business rules live in services and are enforced again in the database where it matters (CHECK constraints, triggers, partial unique indexes).
- Prisma schema with migrations in `prisma/migrations`, including hand-written SQL for row-level security. Seeds and demo loaders are idempotent (natural keys, safe to repeat).
- Money-like exactness where needed (decimal arithmetic for grades), deadlines in the campus time zone.

### Events and files
- A transactional **outbox**: events are written in the same transaction as the change and consumed by a worker (or, optionally, relayed through Kafka); handling is at-least-once with de-duplication, retries and a dead-letter path.
- Files go straight from the browser to S3-compatible storage through presigned URLs; the server confirms the object exists and has the declared size. Storage keys always start with the tenant.

### Security habits
- Password rules, lockout, session limits and optional two-step verification are realm settings managed per company; secrets are never shown again after saving.
- Public endpoints (for example transcript verification) are rate limited; CSV exports neutralize spreadsheet formulas; API documentation is off in production.
- Demo accounts and data exist only in companies explicitly marked as demo companies; the demo scripts refuse to run with `NODE_ENV=production` unless told otherwise.

### Quality
- **Tests run against the real thing**: PostgreSQL, Redis and Keycloak (jest end-to-end and integration tests), plus unit tests for pure logic (vitest). Golden tests recompute the sample company's 198 submissions exactly.
- A **cross-tenant leak scan** exercises every read and write with another tenant's ids; a schema test checks row-level security on every table.
- CI runs lint, type checks and the whole suite on every push.
- A browser check of the main flows is part of finishing a feature.

### Working conventions
- Work is delivered in numbered milestones (`B1`, `B2`, ...): one branch per milestone, a pull-request-sized change with its tests and docs, merged with `--no-ff` and tagged `biz-b<N>` once CI is green.
- English first for code, messages and documents; Chinese is a second language in the UI and in `*.chn.md` documents.

## Architecture and technology

| Part | Technology |
|---|---|
| API | NestJS, TypeScript, Prisma, PostgreSQL with row-level security |
| Web | Next.js 15 (App Router), Tailwind CSS, next-intl; three entries in one app: student portal `/`, admin console `/admin`, platform console (`platform.*` host) |
| Identity | Keycloak, one realm per tenant plus a platform realm |
| Cache, sessions, locks | Redis |
| Files | S3-compatible object storage |
| Mail | SMTP (Mailpit in development) |
| Events | Outbox table; optional single-node Kafka (KRaft) |
| Tests | jest (API), vitest (web, shared), supertest |

## Repository layout

| Path | What |
|---|---|
| `apps/api` | NestJS API (port 4000). `GET /healthz` checks Postgres and Redis. |
| `apps/web` | Next.js app (port 3001). |
| `packages/shared` | Shared code: permission codes, menu catalog, role templates, tenant-code rules, the Keycloak realm template, pure business logic (quota, curriculum versions) and the module generator core. |
| `prisma/` | Schema and migrations (`biz` schema). |
| `deploy/compose` | Docker Compose for Postgres, Redis, object storage, Keycloak, Mailpit (and optional Kafka). Ports differ from the AI module so both can run together. |
| `deploy/keycloak` | Password block list and the demo-only login theme. |
| `scripts/` | Provisioning, seeding, demo loading and reset, module generator, local password helper. |

## Commands you will use

```bash
pnpm lint && pnpm typecheck && pnpm test   # tests need the Docker services (make up)
pnpm test:leak                             # only the cross-tenant leak scan
pnpm gen:module --name ... --group ... --fields "..." --label "..."   # scaffold a resource
pnpm demo                                  # load demo companies, data and accounts
pnpm demo:reset                            # rebuild the demo data from scratch
```

Ports: Postgres 5433, Redis 6380, object store 9100/9101, Keycloak 8180, Mailpit 1125 (SMTP) and 8125 (web), API 4000, web 3001.

## What it deliberately does not do

No virus scan of uploaded files, no plagiarism detection, no make-up exams, pass/fail courses or dropped-lowest-score rules, no payment or tuition, no student-facing mobile app. The administrator never sees business data. Some of these are listed as ideas, not promises.

## More

- Hands-on guide with setup, trial data, test accounts and walk-throughs: **[TRY-IT.md](TRY-IT.md)**.
- The AI module and the repository overview: [../README.md](../README.md).
- License: MIT (see the repository root).
