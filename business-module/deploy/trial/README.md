# Hosted trial site

Files for running the business module as a **public trial**: visitors sign in with the demo accounts on the login page, try everything, and the data is rebuilt every day. This is optional; a normal deployment ignores all of it.

## What the protection does

Set `TRIAL_PROTECT=1` on the API (see `env.example`). Then:

- **Demo companies only.** On tenant hosts the switch applies only to a company marked as a demo company (`seed:demo` marks them). A real company is never affected, even if the switch is left on by mistake.
- **A deny-list, not read-only.** Visitors can create, edit and delete almost everything, because that is what the trial is for. The API answers `403` with `code: "trial_restricted"` and the message *This action is turned off in the public trial.* for the few things that can be abused or lock everyone out:
  - creating accounts, disabling an account, changing an email, sending an invite, a reset link or a temporary password, unlocking (they send mail and change sign-in);
  - on the platform host: creating or editing companies, changing a company's status, its admin account or its sign-in security, platform accounts and roles, and the menu and entry structure.
- **Everything else is rebuilt, not rolled back.** `pnpm demo:reset` removes all business data of the demo companies and builds the scenario again, so visitors' changes disappear on the next run.

The rules are one short list in [`apps/api/src/demo/trial-protect.ts`](../../apps/api/src/demo/trial-protect.ts), with tests.

## What the protection cannot do from inside the app

| Concern | What to set |
|---|---|
| Visitors changing their own password in the Keycloak account console | Block `/realms/*/account` at the reverse proxy: [`nginx.conf.example`](nginx.conf.example) |
| Large uploads | Set `UPLOAD_MAX_BYTES` (assignment files) and `LIBRARY_MAX_BYTES` (document library) low, see `env.example` |
| Mail to strangers | Point SMTP at a blackhole or at Mailpit; the demo accounts use `*.example` addresses |
| Abuse and scraping | Rate limits and a firewall at the proxy; the app only limits its public endpoints |

## Daily reset

`pnpm demo:reset` takes a minute or two. Run it from the machine that has the project and `.env`:

- cron: [`demo-reset.cron.example`](demo-reset.cron.example)
- systemd timer: [`demo-reset.service.example`](demo-reset.service.example) and [`demo-reset.timer.example`](demo-reset.timer.example)

The reset refuses to run under `NODE_ENV=production` unless `ALLOW_DEMO_SEED=1` is set, which a trial host sets on purpose and a real deployment never does. Put a notice in the page with `TRIAL_BANNER` (shown above every page, read at run time).

## Checklist

1. Deploy as usual; set the variables from `env.example`.
2. `pnpm demo` once to load the demo companies, accounts and data.
3. Install the daily reset (cron or timer).
4. Put the proxy rules from `nginx.conf.example` in place.
5. Open each entry (student portal, admin, platform) with the accounts on the login page and try a blocked action: you should see the trial message.
