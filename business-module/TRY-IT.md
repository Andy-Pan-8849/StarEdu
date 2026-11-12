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
pnpm seed          # opens two demo companies: hq (headquarters) and franchise
pnpm dev:api       # terminal 1
pnpm dev:web       # terminal 2
```

If you started this stack with an earlier milestone, run `make reset` first, then the steps above.

Open **http://hq.localhost:3001/admin** (`*.localhost` names resolve to your machine in most browsers; otherwise add them to `/etc/hosts`). Outgoing mail (invitations, password links) appears in Mailpit at http://localhost:8125.

## 2. Demo companies and accounts

| Company | Address | Type |
|---|---|---|
| StarIT (headquarters) | http://hq.localhost:3001 | direct |
| StarIT Franchise | http://franchise.localhost:3001 | franchise |

Each company is a separate tenant with its own users, roles and data; a person in one company can never see the other's data.

| Account | Company | Role | Password |
|---|---|---|---|
| `admin` | hq | Tenant administrator (built-in) | you set it, see below |
| `admin` | franchise | Tenant administrator (built-in) | you set it, see below |

Set a password for the built-in administrator (local use only; the real flow is the invitation e-mail in Mailpit):

```bash
pnpm dev:password --code hq --username admin --password '<10+ characters, upper and lower case, digit, special character>'
```

**More demo accounts (teacher, student, HR manager, academic manager, campus lead, franchise staff) and sample data (campuses, departments, courses, classes, assignments, grades) arrive with the milestones that need them** and will be created by `pnpm seed`. They will be listed in this table. Until then you can create accounts yourself, see "Create an account" below.

## 3. Walk-through by role

### Tenant administrator (works today)

Signs in at `/admin`. The administrator has every operation permission of the features the platform enabled for the company, but **no access to business data** (students, grades) by design. The administrator manages the system itself.

What you can do now:

1. **See your menu.** The left tree shows only what your roles allow. Click a menu to open it in a tab; close tabs with ×.
2. **Online users** (System management): who is signed in, from where, since when. **Force logout** ends a person's session; their next request is refused.
3. **Login log**: every sign-in to the admin console or portal, including refused ones and why.
4. **Audit log**: who changed roles, permissions, menus, accounts or sessions, and what changed.
5. **Roles, menus, entries, data scopes, accounts**: the rules and the API are in place; the screens arrive in milestone B4. Until then use the API (section 4).
6. **Sign out** with the link at the top right.

### HR manager, academic manager, campus lead, teacher, student

These roles exist as templates (the student role is built in), but **their screens do not exist yet**:

| Role | Typical work | Arrives in |
|---|---|---|
| HR manager | staff records, departments, posts | B5 |
| Academic manager | programs, courses, classes, enrollment | B6 |
| Campus lead | the same work, limited to their own campus | B5-B8 |
| Teacher | their classes, assignments, grading | B6-B8 |
| Student | courses, assignments, grades, transcript, AI assistant | B6-B10 |

Each section of this guide will be filled in with the exact steps when its milestone is done.

### Platform operator

Opens tenants and manages platform accounts. Screens arrive in B3. Today a tenant is opened with `pnpm provision` (see the main README).

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
