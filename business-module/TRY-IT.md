# Try it: a guide for learners and employers

[中文版](TRY-IT.chn.md) · [What the system is and how it is built](README.md)

This guide gets the business module running on your own machine, loads a realistic company into it, and shows what to click as each kind of user. About 15 minutes once Docker has pulled its images.

## 1. What you need

| Need | Notes |
|---|---|
| Node.js **20.19 or newer** and **pnpm 10** | `node -v`, `pnpm -v` |
| **Docker** with Compose | A few GB of free memory for Postgres, Redis, object storage, Keycloak and Mailpit. The AI module has its own Compose project with different ports, so both can run together. |
| macOS, Linux or Windows | Windows works with Docker Desktop; if something misbehaves, try WSL. |
| A modern browser | `*.localhost` names must resolve to your machine (Chrome, Edge and Firefox do this; otherwise add `hq.localhost`, `riverside-franchise.localhost` and `platform.localhost` to `/etc/hosts`). |
| Free ports | Postgres 5433, Redis 6380, object store 9100/9101, Keycloak 8180, Mailpit 1125 and 8125, API 4000, web 3001. |

No API keys are needed for the business module. (The optional AI assistant needs the AI module and an LLM key; see section 7.)

## 2. Build it

From `business-module/`:

```bash
cp .env.example .env        # defaults are for local demos only
pnpm install
make up                     # Postgres, Redis, object store, Keycloak, Mailpit (wait until they are healthy)
pnpm migrate                # create the database schema
pnpm realm                  # create the platform sign-in realm
```

Then load the trial data (section 3) and start the two servers in two terminals:

```bash
pnpm dev:api                # http://localhost:4000/healthz  ->  {"status":"ok", ...}
pnpm dev:web                # http://hq.localhost:3001
```

Outgoing mail (invitations, notifications) appears in Mailpit at <http://localhost:8125>. The Keycloak admin console is at <http://localhost:8180> (`admin` / `admin` by default in `.env`).

## 3. Load the trial data

```bash
pnpm demo
```

`pnpm demo` is `pnpm seed` (opens two companies) + `pnpm import:sample` (people from the AI module's sample company) + `pnpm seed:demo` (teaching data, demo accounts, documents). It takes a minute or two and is safe to repeat.

What you get:

| Company | Address | What it holds |
|---|---|---|
| **StarIT** (`hq`) | <http://hq.localhost:3001> | The fullest data: 8 campuses, about 200 people (141 staff and 60 students from the sample company), a finished spring term with 20 sections and 198 graded submissions, a document library of 27 files, plus the **living scenario** below. |
| **StarIT RiverSide** (`riverside-franchise`) | <http://riverside-franchise.localhost:3001> | A franchisee on the same system: a small but complete company of its own (same course codes, different people and data), to show that companies cannot see each other. |

The **living scenario** (built relative to the day you load it, in both companies):

- a *previous term*, ended, whose final grades were published a few days ago (so the 14-day grade-appeal window is open) and one grade amendment on record;
- a *current term* in enrollment with three sections (the Java section is nearly full), each with Homework 1 graded and published, Homework 2 submitted but **not yet graded** (some late), Homework 3 still open, a manually scored midterm and an unpublished project draft;
- a *next term* in planning;
- student requests: one pending extension, one pending grade appeal, one approved and one rejected;
- announcements (company, campus, section), discussion threads (pinned, answered, solved), notifications, one valid and one revoked official transcript, two curriculum versions (old and new), and account and storage limits so the usage page has something to show.

Because dates are relative, **run `pnpm demo:reset` before a demonstration** to get fresh deadlines. It clears the demo companies' business data (keeping the companies, their sign-in realms, built-in administrators, roles, departments and campuses), deletes their demo users, re-imports the sample and regenerates everything. It refuses to touch any company that is not marked as a demo company.

## 4. Sign in with the demo accounts

Open any entry's login page:

| Entry | Address |
|---|---|
| Student portal | <http://hq.localhost:3001/> |
| Admin console | <http://hq.localhost:3001/admin> |
| Platform console | <http://platform.localhost:3001/> |

Under the **Sign in** button a block says *"The accounts below are for demonstration only."* and lists the demo accounts of both companies and of the platform. **Click one and you are signed in**, even if the account belongs to another entry or company (it takes you there first), so you never have to hop around. The password for all of them is `Demo!Passw0rd2026`.

| Account | Entry | What it is for |
|---|---|---|
| `demo.admin` | admin | The **demo superuser**: every admin menu and button with the "all data" scope, plus assistant instructor of the Python section. Shows every feature from one account. |
| `demo.registrar` | admin | Academic office: terms, courses, majors, sections, enrollment, batch enrollment, grade amendments, transcripts, student requests. |
| `demo.teacher` | admin | Lead instructor of the three current sections: assignments, grading, extensions, grade book, discussions. |
| `demo.student1`, `demo.student2` | portal | Students with history: enrolled this term, one graded and one ungraded assignment, an upcoming deadline, a pending request, a grade still inside the appeal window, messages, a transcript. Student 1 follows the old curriculum, student 2 the new one. |
| `demo.operator` | platform | The platform operator: companies, features, usage and quota, sign-in settings, jobs, announcements. |
| `rv.admin`, `rv.registrar`, `rv.teacher`, `rv.student1`, `rv.student2` | admin / portal | The same five roles in the second company. |

The `demo.admin` account is the built-in tenant administrator **plus** a `demo-superuser` role that exists only in demo companies. The built-in administrator alone has no access to business data by design.

There are also older accounts from the AI sample (same password): `ling.mgr.bj` and `peng.mgr.sh` (campus leads), `qing.hr.bj` (HR manager), `wei.acad.sh` (teacher), `wei.stu.sh` (student), `tao.admin.bj` (tenant administrator). Everyone is linked to the same person as in the AI module's sample data.

> **Security note.** The login block puts a public password and the platform account on a public page. That is only acceptable on a demonstration environment that holds no real data and is not exposed beyond the people you invite. The demo scripts refuse to run with `NODE_ENV=production` unless `ALLOW_DEMO_SEED=1` is set. To remove the block, delete the `scripts=` line in `deploy/keycloak/themes/staredu-demo/login/theme.properties` (or the whole theme folder).

You can also give the built-in `admin` of a company a password yourself (local use only):

```bash
pnpm dev:password --code hq --username admin --password '<10+ characters, upper and lower case, digit, special character>'
```

## 5. What to try, by role

### Student (`demo.student1`, portal)
- **My requests**: ask for an extension on Homework 3 and **withdraw** it; ask to appeal the published grade (a reason of at least 10 characters is required).
- **My assignments**: open Homework 3 and submit text and a file (up to 10 files, 20 MB each; they go straight to object storage). Late work loses 10% up to 24 hours late, 20% up to 48, 30% up to 72, nothing after that. Scores, rubric points and feedback appear **only after the teacher publishes**.
- **Course enrollment**: open sections with seats left, required/elective labels for your major, missing prerequisites, schedule clashes; **Enroll** and **Drop** (the screen warns when a drop becomes a "W").
- **Degree plan** (student 1 and 2 see different curriculum versions), **My grades** (GPA by term and cumulative, download an unofficial transcript PDF), **Discussions**, **Library**, the **bell** (messages, settings per category, e-mail in Mailpit), and **AI assistant** (needs the AI module).

### Teacher (`demo.teacher`, admin console)
- **Sections**: you only see your own three. Open one: roster, **Course materials**, **Assignments**, **Grades**, **Discussion** tabs.
- **Assignments > Homework 2 > Submissions**: ungraded work waits here. Score each rubric item, add feedback, then **publish** one score or all fully scored ones.
- **Extensions**: give one student 1–3 more days with a reason.
- **Student requests**: approve the pending extension (you can change the days). You can see grade appeals and reject them, but changing a published grade needs the academic office.
- **Grades**: set group weights (must total 100%), see the grade book (missing work counts as 0), enter the midterm scores by hand, calculate and publish final grades, export CSV. After a section ends its grades are locked.
- **Discussion**: reply, pin, mark solved.

### Academic office (`demo.registrar`)
- **Student requests**: approve the grade appeal (a new total and a note of at least 5 characters are required; the change is recorded before and after).
- **Sections** > **Batch enrollment**: pick a term, course and major (optionally entry year and campus), **Preview**, then **Run for real**. Exceptions (over capacity, prerequisite, clash, closed window, retake) need to be ticked with a reason.
- **Terms, Courses, Majors** (> **Curriculum**: two versions; **Add version** copies the one you are looking at), **Sections**, **Grading scale**, **Transcripts** (issue an official numbered PDF; each copy has a verification page and a **Revoke** button), **Announcements**, **Dashboard** (only for the campuses your scope allows).

### Everything in one account (`demo.admin`)
Open the menu and walk through: **Roles** (create a role, tick menus, pick data scopes; an older copy of a template role can show **Update from template**), **Accounts** (invitation, reset link, temporary password), **Online users** (force logout), **Login log / Audit log / Operation log**, **Campuses and Departments**, **Staff and Students** (HR), **Document library** (public, internal and confidential folders; confidential ones need a logged self-grant even for the administrator), **Transcripts**, **Student requests**, **Sections**.

### HR manager (`qing.hr.bj`)
Add a staff member (a duplicate e-mail is refused and the existing person is shown), add a second assignment or **transfer** (history is kept), **end employment** now or on a planned date (the person loses admin access at once) and reinstate, add a student with a campus, add a student profile to an existing person, emergency contacts, **import and export CSV** (check first; repeating changes nothing).

### Campus lead (`ling.mgr.bj`)
Sees only their own campus's staff, students and sections.

### Platform operator (`demo.operator`, <http://platform.localhost:3001/>)
- Companies: open a new company (the administrator gets an invitation in Mailpit), **notify** a planned suspension, **suspend** (its users are refused, data kept) and **restore**, switch **features** on or off for one company.
- **Usage & quota**: accounts and storage in use; set limits (at a limit, new accounts are refused with 409 and uploads with 413; nothing is deleted).
- **Sign-in & security**: password rules, lockout, session time, two-step verification for everyone, optional Google sign-in (links only to existing accounts with the same verified e-mail).
- **Scheduled jobs** (enable, change the schedule, run now, see the run log; enable "Send assignment deadline reminders"), **Monitoring**, platform announcements (API).

### The "why is this safe" tour
1. Sign in as `demo.admin`, then as `rv.admin`: different people, classes and requests. A token for one company is refused on the other's address.
2. As `demo.teacher`, you cannot open another teacher's section; as `demo.student1`, you never see another student's submission.
3. Two accounts with the same role but different departments see different people; "no data scope" means no rows, never everything.
4. Force a user out in **Online users**: their next request is refused even though the sign-in token is still valid for a few minutes.
5. Open the verification page of a transcript (**Transcripts** > *Verification page*): a valid copy and a revoked copy.

## 6. Reset and troubleshooting

```bash
pnpm demo:reset     # rebuild the demo companies' data (fresh dates)
make reset          # remove all local data of this module (not the AI module); then repeat sections 2 and 3
```

| Symptom | What to do |
|---|---|
| `*.localhost` does not open | Add the three names to `/etc/hosts` pointing at `127.0.0.1`. |
| The login page shows no demo accounts | Keycloak was started before the theme was mounted: run `make up` again, then `pnpm seed:demo`. |
| A menu shows but the page says "Missing permission" (after upgrading from an older version) | Run `pnpm seed`: it adds missing menus and refreshes cached permissions. For roles you copied earlier, use **Roles > Update from template**. |
| "No access" after signing in at the admin console | The account has no admin permissions (students and some demo staff accounts only use the portal). Use `demo.admin`. |
| "Nothing here" in lists for a tenant administrator | By design the administrator has no business data scope; use `demo.admin` or `demo.registrar`. |
| Deadlines look old | `pnpm demo:reset`. |
| Port already in use | The AI module uses different ports (3000, 5432, 6379, 8080). Check that nothing else uses the ports in section 1. |
| API refuses to start with "Invalid environment" | Run it with `pnpm dev:api` (it loads `.env`) and make sure `.env` exists. |

## 7. Optional extras

### The AI assistant in business mode
The AI module (`../ai-module/`) normally runs on its own sample company. To let it answer from this module's data:

1. In `business-module/.env` set `INTERNAL_API_KEY=<a secret>`, restart `pnpm dev:api`, and create the companies again (`pnpm demo:reset`), because a company opened earlier has no `ai` sign-in client.
2. In `ai-module/.env` set `STARIT_IDENTITY_MODE=business`, `STARIT_OIDC_TENANT_ISSUER_BASE=http://localhost:8180/realms`, `STARIT_BUSINESS_INTERNAL_KEY=<the same secret>` and `STARIT_CORS_ORIGINS=http://hq.localhost:3000` (see `ai-module/.env.example`), then `make migrate` and start the AI module (it needs an LLM API key).
3. Sign in as `demo.teacher` or `demo.student1` and click **AI assistant**. A student asking for "all students' grades" gets only their own.

### The Kafka event bus
Nothing above needs Kafka. To see it: `make biz-up-kafka`, set `BIZ_EVENT_BUS=kafka` in `.env`, restart `pnpm dev:api`, then do something that sends a notification (enroll a student as the registrar). The event goes outbox table → Kafka topic `business.events` → consumer group → the bell. Stop the broker with `make biz-down-kafka` and keep working: events wait in the table and arrive afterwards. `make test-events` runs the tests against the real broker.

### Calling the API directly
After signing in, in the browser's developer console:

```js
const call = (path, method = "GET", body) =>
  fetch("/bff/" + path, { method, headers: { "x-requested-with": "staredu", "content-type": "application/json" }, body: body && JSON.stringify(body) }).then((r) => r.json());
await call("roles");              // list roles
await call("roles/menu-tree");    // menus and buttons you can tick
```

API documentation is at <http://localhost:4000/api-docs> (development only; it has no sign-in, so do not expose it).

### Hosting a public trial

To put the demo on a server for others to try, turn on the trial protection and schedule the daily reset. Visitors can still create, edit and delete almost everything; only account creation, sign-in changes and the platform's company administration are turned off, and the data is rebuilt every day. Settings, proxy rules and the cron or timer files are in [`deploy/trial/`](deploy/trial/README.md).

### Scaffold your own resource
`pnpm gen:module --name warehouse-item --group edu --fields "title:string!,qty:int,due:date,done:bool,notes:text" --label "Warehouse items" --label-zh "仓库物品"`, then `pnpm migrate && pnpm prisma:generate && pnpm --filter @staredu/shared build`. It creates the table (with row-level security), API, permissions, menu, page, tests and leak-scan entries; `--dry-run` lists the files without writing.

### Checks
```bash
pnpm lint && pnpm typecheck && pnpm test   # needs the Docker services from `make up`
pnpm test:leak                             # the cross-tenant leak scan only
```
