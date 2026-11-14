# Try it: a guide for learners and employers

This guide shows how to start the business module, which accounts to sign in with, and what each kind of user can do. **It grows with every milestone**: each section says what works today and what is still to come, so you never have to guess.

Status: **milestone B9b.** Sign-in, the platform console, system management, people, teaching, assignments, grades, notifications and class discussion work. The AI assistant is not built yet; their menus show "This page is not available yet."

## 1. Start it

Requires Node 20.19+, pnpm 10 and Docker. From `business-module/`:

```bash
cp .env.example .env
pnpm install
make up            # Postgres, Redis, object store, Keycloak, Mailpit
pnpm migrate
pnpm realm         # platform realm
pnpm seed          # opens two demo companies: hq (StarIT) and riverside-franchise (StarIT-RiverSide)
pnpm dev:api       # terminal 1
pnpm dev:web       # terminal 2
```

If you started this stack with an earlier milestone, run `make reset` first, then the steps above. (Or keep your data: `pnpm migrate`, then `pnpm seed`, then `make up` so the object store is running.) Transcript PDFs use a bundled Noto Sans SC subset (the 3,755 most common hanzi); a rarer character prints as `?`. Assignment files go to the object store (`objectstore`, port 9100); the first upload creates the bucket.

Open **http://hq.localhost:3001/admin** (`*.localhost` names resolve to your machine in most browsers; otherwise add them to `/etc/hosts`). Outgoing mail (invitations, password links) appears in Mailpit at http://localhost:8125.

## 2. Demo companies and accounts

| Company | Address | What it shows |
|---|---|---|
| **StarIT** (headquarters group) | http://hq.localhost:3001 | The Beijing campus ("StarIT北京总部", code `HQ`) is the headquarters and has the **fullest data**: every feature and the edge cases can be tried here. Shanghai is a branch campus with the organization structure and the basic flows. |
| **StarIT-RiverSide** (中文名 StarIT 河岸教育) | http://riverside-franchise.localhost:3001 | A franchisee: a separate company on the same system, with basic data and the main flows. Use it to see that two companies never see each other's data. |

Each company is a separate tenant with its own users, roles and data.

**Accounts available today**

| Account | Company | Role | Password |
|---|---|---|---|
| `admin` | hq | Tenant administrator (built-in) | you set it, see below |
| `admin` | riverside-franchise | Tenant administrator (built-in) | you set it, see below |

```bash
# local use only; the real flow is the invitation e-mail in Mailpit
pnpm dev:password --code hq --username admin --password '<10+ characters, upper and lower case, digit, special character>'
pnpm dev:password --code riverside-franchise --username admin --password '<...>'
```

**Accounts coming with later milestones.** They are created by `pnpm seed` and share one public demo password that will be written here (for local and trial use only).

| Account | Company | Role | Available from |
|---|---|---|---|
| `ling.mgr.bj`, `peng.mgr.sh` | hq | Campus lead (Beijing, Shanghai) | B5 |
| `qing.hr.bj` | hq | HR manager | B5 |
| `hui.acad.bj` | hq | Academic manager | B6 |
| `fang.tch.bj`, `wei.acad.sh` | hq | Teacher | B6 |
| `peng.stu.bj`, `kai.stu.bj` (on leave), `wei.stu.sh` | hq | Student | B6 |
| `tao.admin.bj` | hq | System operator (system management only) | B4 |
| `ning.adm.bj`, `ning.fin.bj`, `min.ragetl.bj` | hq | Staff with few permissions (used to show what the AI assistant may answer) | B5 |
| `river.hr`, `river.acad`, `river.tch`, `river.stu` | riverside-franchise | HR manager, academic manager, teacher, student | B5-B6 |

## 3. Walk-through by role

Every flow below says when it can be tried. "Works today" means you can do it now.

### Tenant administrator (`admin`)

The administrator has every operation permission of the features enabled for the company, but **no access to business data** (students, grades) by design: it manages the system itself.

| Flow | Available |
|---|---|
| Sign in to `/admin`; the menu shows only system management and what your roles allow | Works today |
| **Online users**: see who is signed in; **Force logout** ends a session (the person's next request is refused) | Works today |
| **Login log** and **Audit log**: who signed in, who changed roles, permissions, menus, accounts or sessions | Works today |
| **Accounts**: create an account (invitation e-mail), assign roles, enable or disable, resend the invitation, send a reset link, create a **temporary password** (12 characters, shown once, the person must change it at next sign-in), unlock | Works today |
| **Roles**: create a role, tick its menus and buttons, choose its data scopes; watch an account's menu change | Works today |
| **Data scopes**: pick departments in the tree (with or without sub-departments) | Works today |
| **Menus** and **Entry assignment**: add a directory or an external link, assign it to the admin console or the student portal | Works today |
| **Campuses**: add a campus (its root department is created for you); stop new intake; close it only when no students or staff assignments are left (type its name to confirm); reopen | Works today |
| **Departments** and **Posts**: build the tree, move departments, disable or delete (departments with people, sub-departments or a campus can only be disabled) | Works today |
| **Dictionaries** and **Parameters**: the platform's are read-only; add your own | Works today |
| **Operation log**: who changed what (passwords and tokens are masked, responses are never stored); clearing needs its own permission | Works today |

### HR manager (`hr-manager` role; demo account `qing.hr.bj` arrives with the demo seed)

| Flow | Available |
|---|---|
| **Add a staff member** (name, e-mail, hire date, department); a duplicate e-mail is refused and the existing person is shown | Works today |
| **Assignments**: add a second department, set the primary, **transfer** (old assignment ends, history is kept) | Works today |
| **End employment** now or on a planned date; the person loses admin access at once and is signed out; **reinstate** | Works today |
| **Students**: add with a campus, change status (enrolled, on leave, graduated, withdrawn, completed), move to another campus | Works today |
| One person as both staff and student: add the student profile to the existing person | Works today |
| **Emergency contacts** and sensitive information (ID number, phone, address) | Works today (API for sensitive fields; emergency contacts have a tab) |
| **Import CSV** (check first, then import; repeat safely) and **export CSV** | Works today |

Try this as the tenant administrator too: the **Staff** list shows basic information only, **Students** is empty, and emergency contacts and sensitive fields are refused. That is the minimum-data design.

To load the sample company into `hq`: `pnpm import:sample`.

### Academic manager (`academic-manager` role; demo account `hui.acad.bj` arrives with the demo seed)

| Flow | Available |
|---|---|
| **Terms**: create, open enrollment (window and drop deadline), start, end (sections end, enrolled records complete) | Works today |
| **Courses** and **prerequisites**; **majors** and their **curriculum** (required / elective / general, suggested term) | Works today |
| **Sections**: create (course, term, campus, capacity), assign instructors, open, cancel | Works today |
| **Enroll students for them**: over capacity, missing prerequisite, clash or outside the window need a reason and are logged | Works today |
| Remove a student: before the drop deadline the record is voided, after it W | Works today |
| **Grading scale**: edit the grades, minimum percentages, grade points and the pass line for the whole company | Works today |
| **Transcripts**: open a student's transcript (GPA by term and cumulative), issue the **official** PDF (numbered, recorded) | Works today |
| **Announcements** (Messages menu): publish to the whole company (needs the all-data scope), one campus or one section; see who has read it; withdraw | Works today |
| **Dashboard**: students, sections, assignment completion, average score and late rate per campus, only for the campuses you may see | Works today |

### Teacher (`teacher` role)

| Flow | Available |
|---|---|
| See only your own sections and their rosters; you cannot change a section's capacity or status | Works today |
| **Course materials** (title and link; draft or published) for your own sections; read-only after the section ends | Works today |
| **Assignments** tab on a section: create an assignment (due date, rubric of items with points, optional late-work rule), organise them in groups, publish when ready | Works today |
| **Submissions**: see every student of the section (those who have not submitted too), open a submission (all versions, download the files), **score each rubric item**, add feedback, **publish** one score or all that are fully scored | Works today |
| **Extensions**: give one student 1-3 more days with a reason (the deadline moves for that student only; it is logged) | Works today |
| **Discussion** tab: start a discussion, reply, **pin**, mark as **solved**, delete anyone's post (students can delete only their own) | Works today |
| **Grades** tab: set the weight of each assignment group (must total 100%), see the grade book (students by assignments; missing work counts as 0), enter scores for exams by hand, **calculate** and **publish** final grades, export CSV | Works today |
| After the section ends the grades are locked; only the registrar can amend them (reason required, before and after are recorded) | Works today |

### Student (portal at `/`; demo accounts arrive with the demo seed)

| Flow | Available |
|---|---|
| Sign in at the portal; **Course enrollment**: open sections with seats left, required/elective label for your major, missing prerequisites, schedule clashes | Works today |
| **Enroll** and **Drop** (the screen warns when a drop will become a W) | Works today |
| **Degree plan**: your major's courses as passed / in progress / not taken, credits earned | Works today |
| Course materials of the sections you are in | Works today (API) |
| **My assignments**: the published assignments of your sections with deadline (23:59 campus time), rubric and your status; **submit** text and files (up to 10 files, 20 MB each; files go straight to the object store), submit again before the deadline (the last one counts, earlier versions are kept) | Works today |
| After the deadline you can still submit if the assignment accepts late work: 10% off up to 24 hours late, 20% up to 48, 30% up to 72, nothing after that (the teacher can change the table per assignment) | Works today |
| Your score, the points per rubric item and the feedback appear **only after the teacher publishes** | Works today |
| **Discussions** (menu): pick one of your sections, start a thread, reply, mark your own thread as solved, delete your own posts. Students on leave can read only | Works today |
| **My grades**: published final grades by term, GPA by term and cumulative, credits earned; **download an unofficial transcript** (PDF, numbered, footer "for reference only"). Graduated or withdrawn students can still read their grades and download it | Works today |
| **Notifications** (the bell in the top bar): new assignments, published scores and final grades, enrollment changes, announcements, and a reminder in the last 24 hours before a deadline. New ones appear at once. **Settings** in the bell: language, and per category whether you want it in the app and by e-mail. Every e-mail has an unsubscribe link (see them in Mailpit at http://localhost:8125) | Works today |
| AI assistant | B10 |

### Campus lead

Sees only their own campus's staff, students and sections (works today with the role template).

### Platform operator (works today)

Signs in at **http://platform.localhost:3001** (create the first account with `pnpm realm` and `pnpm bootstrap:platform`; locally set a password with `pnpm dev:password --platform --username root --password '...'`).

| Flow | Available |
|---|---|
| See all companies with status and administrator | Works today |
| **Open a company**: code, name, type, administrator e-mail; the administrator receives an invitation (Mailpit) | Works today |
| **Notify** a planned suspension (e-mail to the administrator), **suspend** (the company's users are refused, data is kept), **restore** | Works today |
| **Features**: switch features (menus) on or off for one company; its menus and permissions change at once | Works today |
| **Administrator**: resend the invitation, send a password reset link, unlock after failed sign-ins, change the e-mail | Works today (API; resend and unlock are buttons) |
| **Scheduled jobs**: enable a job, change its schedule, run it now, see the run log (new: **Send assignment deadline reminders**, enable it to get reminders) | Works today |
| **Platform announcements**: a banner for every company during a time window | API today (`/api/platform/announcements`) |
| **Monitoring**: server, cache and database health; links to API documentation and Grafana | Works today |
| Platform accounts and roles, menus, entry assignment | API today (`/api/platform/...`); screens later |

### Things to try across companies (the "why is this safe" tour)

| Try | Available |
|---|---|
| Sign in as `admin` of hq, then of riverside-franchise: different people and roles; a token for one company is refused on the other's address | Works today |
| Two teachers with the same role but different departments see different students | B5-B6 |
| A teacher who does not teach a section cannot see or grade its assignments; a student never sees another student's submission | Works today |
| The Beijing campus lead cannot find Shanghai students; the group HR manager sees both | B5 |

## 4. Using the API directly (optional)

The screens above call the same endpoints. A convenient way to try it is the browser's developer console on an admin page, after signing in:

```js
const call = (path, method = "GET", body) =>
  fetch("/bff/" + path, { method, headers: { "x-requested-with": "staredu", "content-type": "application/json" }, body: body && JSON.stringify(body) }).then((r) => r.json());

await call("roles", "POST", { code: "auditor", name: "Auditor" });   // new role
await call("roles");                                                  // list roles
await call("roles/menu-tree");                                        // menus and buttons you can tick
await call("data-scope-sets");                                        // data scopes you can give a role
```

Then tick menus with `PUT roles/<id>/menus {menuIds:[...]}`, choose data scopes with `PUT roles/<id>/data-scopes {setIds:[...]}`, create a person's account with `POST accounts {username, email}` and give them the role with `PUT accounts/<id>/roles {roleIds:[...]}`. The new person receives an invitation e-mail (see Mailpit) and sets a password.

## 5. Optional: the Kafka event bus

Nothing in the walk-through above needs Kafka. To see it work: `make biz-up-kafka`, set `BIZ_EVENT_BUS=kafka` in `.env`, restart `pnpm dev:api`, then do anything that sends a notification (for example enroll a student as the registrar). The event goes outbox table, Kafka topic `business.events`, a consumer group, and then the bell. Stop the broker with `make biz-down-kafka` and keep working: events wait in the table and arrive after you start it again. Messages that cannot be handled land in `business.events.dlq`. `make test-events` runs the tests against the real broker.

## 6. What to notice when you evaluate

- **Menus follow permissions.** Give an account a role with one menu ticked and sign in as that account: only that menu appears. Remove the role and the menu disappears on the next request.
- **Data scope.** Two people with the same role but different departments see different people. "No data scope" means no rows, never "everything".
- **Isolation.** Two companies share one system but not one row. The test suite proves this for every endpoint (`pnpm test:leak`).
- **Sessions.** Force logout works at once, even though the sign-in token is still valid for a few minutes.

## 7. Reset

```bash
make reset         # removes the local data of this module (not the AI module)
```

Then repeat section 1.
