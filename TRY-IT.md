# Try StarEdu

[中文版](TRY-IT.chn.md) · [Project overview](README.md)

This is the one place to start. It says what to install, how to set up Docker, how to run each part, which accounts to sign in with, and what to do when something is wrong.

## 1. Pick a path

| Path | What you get | Needs |
|---|---|---|
| **B: business module** (start here) | A multi-tenant back office for a training company, with demo companies and accounts. Free. | Docker, Node.js 20.19+, pnpm 10. **No API key.** |
| **A: AI module** | A knowledge assistant: ask in a chat page, get answers with citations filtered by who is asking. A handful of questions costs a few cents of model calls. | Docker, uv, make, an OpenAI API key |
| **C: both together** | The assistant opens from the back office and answers from its data, signed in as the same person. | B and A, plus a few settings |

## 2. What you need

| Need | Path B | Path A |
|---|---|---|
| Docker with Compose | yes | yes |
| Node.js 20.19+ and pnpm 10 | yes | no |
| uv and make | `make` only | yes |
| An OpenAI API key | no | **yes** |

**Docker memory.** The business module needs a few GB, the AI module 8 GB or more. Running both needs the sum (not measured, so give Docker as much as you can). In Docker Desktop: Settings > Resources > Memory. To see what Docker has: `docker info --format '{{.MemTotal}}'` (bytes).

**Ports.** The two parts use different ports, so they do not clash:

| Service | Business module | AI module |
|---|---|---|
| Web | 3001 | 3000 |
| API | 4000 | 8000 |
| Postgres / Redis | 5433 / 6380 | 5432 / 6379 |
| Keycloak (sign-in) | 8180 | 8080 |
| Other | Mailpit 8125 (mail inbox), object store 9100/9101 | |

**Addresses.** The business module tells the company by host name, so `*.localhost` must resolve to your machine (Chrome, Edge and Firefox do this; otherwise add `hq.localhost`, `riverside-franchise.localhost` and `platform.localhost` to `/etc/hosts` pointing at `127.0.0.1`).

## 3. Path B: the business module

From the repository root:

```bash
cd business-module
cp .env.example .env      # defaults are for local demos only
pnpm install
make up                   # Postgres, Redis, object store, Keycloak, Mailpit; wait until healthy
pnpm migrate              # create the database schema
pnpm realm                # create the platform sign-in realm
pnpm demo                 # demo companies, accounts and data (safe to repeat)
```

Then start the two servers, each in its own terminal:

```bash
pnpm dev:api              # http://localhost:4000/healthz should answer {"status":"ok", ...}
pnpm dev:web
```

Open <http://hq.localhost:3001>. The sign-in page lists the demo accounts under the Sign in button: click one and you are in. The table in section 6 says which account opens which entry. What to try as each role, how the data is organised and the troubleshooting list are in [`business-module/TRY-IT.md`](business-module/TRY-IT.md).

## 4. Path A: the AI module

```bash
cd ai-module
make env                  # creates .env; put your OPENAI_API_KEY in it
make sync && make up && make seed
```

Open <http://localhost:3000> and sign in as `wei.stu.sh`, password `demo-pass-123` (a local demo account). Then:

- Ask `What does ERR-PORTAL-429 mean?`: you get an answer with a citation you can open.
- Sign out, sign in as `qing.hr.bj` (HR) and ask `What is the base salary band for a Senior Instructor at a Tier 1 campus?`: HR gets the band. Ask the same question as `wei.stu.sh` and the student gets the fixed "could not find" reply, without a hint that a restricted document exists.

All eight demo accounts, with three normal and two restricted questions for each, are in [`ai-module/README.md`](ai-module/README.md).

## 5. Path C: both together

In *business mode* you sign in with the company's own login, the assistant asks the back office which data rows and folders that person may see, and reads only through views filtered by that scope. A student who asks for "all students' grades" gets only their own.

1. Finish Path B and Path A (the AI module needs a working `.env` and `make up`).
2. Set a shared secret and the identity mode in both `.env` files, then migrate and restart. The exact variables are in [`business-module/TRY-IT.md`](business-module/TRY-IT.md#the-ai-assistant-in-business-mode). Companies created before this need `pnpm demo:reset`, because they have no sign-in client for the assistant.
3. Sign in to the back office as `demo.teacher` or `demo.student1` and click **AI assistant**.

## 6. Daily use

**Accounts.** Business module password for every demo account: `Demo!Passw0rd2026`. AI module: `demo-pass-123`. Both are public demo passwords for local use only.

| To try | Account | Address |
|---|---|---|
| Student portal | `demo.student1` | <http://hq.localhost:3001> |
| Teacher (admin console) | `demo.teacher` | <http://hq.localhost:3001/admin> |
| Everything in the admin console | `demo.admin` | <http://hq.localhost:3001/admin> |
| Academic office | `demo.registrar` | <http://hq.localhost:3001/admin> |
| Another company (isolation) | `rv.admin` | <http://riverside-franchise.localhost:3001/admin> |
| Platform console | `demo.operator` | <http://platform.localhost:3001> |
| AI chat on its own | `wei.stu.sh`, `qing.hr.bj` | <http://localhost:3000> |

Other tools: mail inbox <http://localhost:8125>, Keycloak admin <http://localhost:8180> (`admin` / `admin` by default), API documentation <http://localhost:4000/api-docs> (development only).

**Check, stop, reset.**

```bash
docker ps --format '{{.Names}} {{.Status}}'      # every container should be Up / healthy
cd business-module && pnpm demo:reset            # rebuild the demo data with fresh dates
cd business-module && make down                  # stop (keeps data); make reset deletes this module's data
cd ai-module && make down                        # stop (keeps data); make clean also deletes the data
```

## 7. When something is wrong

| Symptom | What to do |
|---|---|
| `*.localhost` does not open | Add the names to `/etc/hosts` (section 2). |
| The sign-in page shows no demo accounts | Docker did not see the theme folder (common after switching git branches). In `business-module/`: `docker compose --env-file .env -f deploy/compose/biz.yaml up -d --force-recreate keycloak`, then reload. |
| "No access" after signing in at the admin console | That account is a portal-only user. Use `demo.admin`. |
| Lists say "Nothing here" for a company administrator | By design the administrator has no business data scope; use `demo.admin` or `demo.registrar`. |
| Deadlines look old | `pnpm demo:reset`. |
| Port already in use | Compare with the table in section 2. |
| API refuses to start with "Invalid environment" | Run it with `pnpm dev:api` (it loads `.env`) and make sure `.env` exists. |

More in [`business-module/TRY-IT.md`](business-module/TRY-IT.md#6-reset-and-troubleshooting) and, for the AI module, [`ai-module/README.md`](ai-module/README.md).

## 8. Where things are

| Looking for | Go to |
|---|---|
| What the system does, and how it is built | [`README.md`](README.md), [`business-module/README.md`](business-module/README.md), [`ai-module/README.md`](ai-module/README.md) |
| What to click as each role in the back office | [`business-module/TRY-IT.md`](business-module/TRY-IT.md) |
| Hosting a public trial site | [`business-module/deploy/trial/README.md`](business-module/deploy/trial/README.md) |
| Design documents and evaluation reports | [`docs/`](docs/) |
