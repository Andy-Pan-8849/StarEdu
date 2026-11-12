# Try it: a guide for learners and employers

This guide shows how to start the business module, which accounts to sign in with, and what each kind of user can do. **It grows with every milestone**: each section says what works today and what is still to come, so you never have to guess.

Status: **milestone B2.** Sign-in, roles and permissions, and the admin shell work. Most business pages (people, teaching, assignments, grades) are not built yet; their menus show "This page is not available yet."

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

If you started this stack with an earlier milestone, run `make reset` first, then the steps above.

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
| Create a role, tick its menus and buttons, choose its data scope, give it to an account, watch that account's menu change | API today (section 4); screens in B4 |
| Create an account and send the invitation; the person sets a password from the e-mail in Mailpit | API today; screens in B4 |
| Add an external-link menu and assign it to the admin console | B4 |

### HR manager, campus lead, academic manager, teacher, student

| Role | Typical work | Available from |
|---|---|---|
| HR manager | add staff, open their accounts, transfer departments, end employment | B5 |
| Campus lead | see only their own campus's people, classes and grades; post announcements | B5-B9 |
| Academic manager | create programs, courses, terms and classes; enrollment; publish grades; official transcripts | B6-B8 |
| Teacher | see their own classes; set assignments; grade submissions; grant extensions; publish grades | B6-B8 |
| Student | see their own courses, submit assignments, see grades and transcript, get notifications, ask the AI assistant | B6-B10 |

### Platform operator (works today)

Signs in at **http://platform.localhost:3001** (create the first account with `pnpm realm` and `pnpm bootstrap:platform`; locally set a password with `pnpm dev:password --platform --username root --password '...'`).

| Flow | Available |
|---|---|
| See all companies with status and administrator | Works today |
| **Open a company**: code, name, type, administrator e-mail; the administrator receives an invitation (Mailpit) | Works today |
| **Notify** a planned suspension (e-mail to the administrator), **suspend** (the company's users are refused, data is kept), **restore** | Works today |
| **Features**: switch features (menus) on or off for one company; its menus and permissions change at once | Works today |
| **Administrator**: resend the invitation, send a password reset link, unlock after failed sign-ins, change the e-mail | Works today (API; resend and unlock are buttons) |
| **Scheduled jobs**: enable a job, change its schedule, run it now, see the run log | Works today |
| **Monitoring**: server, cache and database health; links to API documentation and Grafana | Works today |
| Platform accounts and roles, menus, entry assignment | API today (`/api/platform/...`); screens later |

### Things to try across companies (the "why is this safe" tour)

| Try | Available |
|---|---|
| Sign in as `admin` of hq, then of riverside-franchise: different people and roles; a token for one company is refused on the other's address | Works today |
| Two teachers with the same role but different departments see different students | B5-B6 |
| The Beijing campus lead cannot find Shanghai students; the group HR manager sees both | B5 |

## 4. Create an account and a role (API, until the screens arrive)

Everything below is also what the screens will call. A convenient way to try it is the browser's developer console on an admin page, after signing in:

```js
const call = (path, method = "GET", body) =>
  fetch("/bff/" + path, { method, headers: { "x-requested-with": "staredu", "content-type": "application/json" }, body: body && JSON.stringify(body) }).then((r) => r.json());

await call("roles", "POST", { code: "auditor", name: "Auditor" });   // new role
await call("roles");                                                  // list roles
await call("roles/menu-tree");                                        // menus and buttons you can tick
await call("data-scope-sets");                                        // data scopes you can give a role
```

Then tick menus with `PUT roles/<id>/menus {menuIds:[...]}`, choose data scopes with `PUT roles/<id>/data-scopes {setIds:[...]}`, create a person's account with `POST accounts {username, email}` and give them the role with `PUT accounts/<id>/roles {roleIds:[...]}`. The new person receives an invitation e-mail (see Mailpit) and sets a password.

## 5. What to notice when you evaluate

- **Menus follow permissions.** Give an account a role with one menu ticked and sign in as that account: only that menu appears. Remove the role and the menu disappears on the next request.
- **Data scope.** Two people with the same role but different departments see different people. "No data scope" means no rows, never "everything".
- **Isolation.** Two companies share one system but not one row. The test suite proves this for every endpoint (`pnpm test:leak`).
- **Sessions.** Force logout works at once, even though the sign-in token is still valid for a few minutes.

## 6. Reset

```bash
make reset         # removes the local data of this module (not the AI module)
```

Then repeat section 1.
