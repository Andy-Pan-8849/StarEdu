# Try StarEdu

[中文版](TRY-IT.chn.md) · [Overview](README.md)

StarEdu has two parts you can run on your own machine, together or one at a time:

| Part | What you get | Needs | Detailed guide |
|---|---|---|---|
| **AI module** | A knowledge assistant: ask questions in a chat page and get answers with citations, filtered by who is asking. | Docker Compose, uv, make, an OpenAI API key | [`ai-module/README.md`](ai-module/README.md) (Chinese) |
| **Business module** | A multi-tenant back office for a training company: people, teaching, assignments, grades, transcripts, notifications, documents. Demo companies and accounts included. | Docker Compose, Node.js 20.19+, pnpm 10. **No API key.** | [`business-module/TRY-IT.md`](business-module/TRY-IT.md) |
| **Both together** | The assistant answers from the back office's data, signed in with the company's own login. | Both of the above | Path C below |

## Which path should I take?

- **I want to see the back office** (permissions, data scope, tenant isolation, the way a real SaaS is built): Path B. It is free, needs no key and has the richer demo.
- **I want to see the AI assistant**: Path A. It costs a few cents of model calls if you ask a handful of questions.
- **I want to see them work together**: do B, then A, then Path C.

## What you need on your machine

| Need | Path A | Path B |
|---|---|---|
| Docker with Compose | yes, 8 GB of memory or more | yes, a few GB |
| Node.js 20.19+ and pnpm 10 | no | yes |
| uv and make | yes | `make` is used for the Docker services |
| An OpenAI API key | **yes** | no |

Running both at once needs the sum of the two memory needs; this has not been measured, so give Docker as much as you can. The two use different ports, so they do not clash:

| Service | AI module | Business module |
|---|---|---|
| Web | 3000 | 3001 |
| API | 8000 | 4000 |
| Postgres / Redis | 5432 / 6379 | 5433 / 6380 |
| Keycloak | 8080 | 8180 |

## Path A: the AI module

```bash
git clone https://github.com/Andy-Pan-8849/StarEdu.git
cd StarEdu/ai-module
make env            # creates .env; put your OPENAI_API_KEY in it
make sync && make up && make seed
```

Open <http://localhost:3000> and sign in as `wei.stu.sh`, password `demo-pass-123` (a local demo account). Then:

- Ask `What does ERR-PORTAL-429 mean?`: you get an answer with a citation you can open.
- Sign out, sign in as `qing.hr.bj` (HR) and ask `What is the base salary band for a Senior Instructor at a Tier 1 campus?`: HR gets the band. Ask the same question as `wei.stu.sh` and the student gets the fixed "could not find" reply, without a hint that a restricted document exists.

All eight demo accounts, with three normal and two restricted questions for each, are in [`ai-module/README.md`](ai-module/README.md) (Chinese). Stop with `make down`; `make clean` also deletes the data.

## Path B: the business module

```bash
cd StarEdu/business-module
cp .env.example .env
pnpm install
make up && pnpm migrate && pnpm realm
pnpm demo                      # demo companies, accounts and data
pnpm dev:api                   # one terminal
pnpm dev:web                   # another terminal
```

Open <http://hq.localhost:3001>. On every sign-in page the demo accounts are listed under the Sign in button: click one and you are in. Try the student portal as `demo.student1`, the admin console as `demo.admin` (one account that holds every admin menu), and the platform console at <http://platform.localhost:3001/> as `demo.operator`. What to try as each role, how to reset the data (`pnpm demo:reset`), and troubleshooting are in [`business-module/TRY-IT.md`](business-module/TRY-IT.md).

## Path C: both together (the assistant on the back office's data)

The assistant can run in *business mode*: you sign in with the company's own login, the assistant asks the back office which data rows and folders that person may see, and reads only through views filtered by that scope. A student who asks for "all students' grades" gets only their own.

1. Finish Path B and Path A (the AI module needs a working `.env` and `make up`).
2. Set a shared secret and the identity mode in both `.env` files, then migrate and restart. The exact variables are in [`business-module/TRY-IT.md`](business-module/TRY-IT.md#the-ai-assistant-in-business-mode).
3. Sign in to the back office as `demo.teacher` or `demo.student1` and click **AI assistant**.

## Stop and clean up

```bash
cd ai-module && make down            # keep data (make clean deletes it)
cd ../business-module && make down
```

## Where things are

| Looking for | Go to |
|---|---|
| What the system does, and how it is built | [`README.md`](README.md), [`business-module/README.md`](business-module/README.md) |
| Hosting a public trial site | [`business-module/deploy/trial/README.md`](business-module/deploy/trial/README.md) |
| Design documents and evaluation reports | [`docs/`](docs/) |
