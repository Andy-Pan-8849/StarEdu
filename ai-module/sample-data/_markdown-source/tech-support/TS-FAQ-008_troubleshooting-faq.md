---
doc_id: TS-FAQ-008
title: Troubleshooting FAQ for Development Environments
domain: tech-support
version: 5.0
status: active
effective_date: 2026-03-01
access: students-and-staff
campus_scope: all
format: md
---

# Troubleshooting FAQ for Development Environments

## Java

**Maven downloads are very slow or time out.**
Add the campus mirror to `~/.m2/settings.xml` as described in TS-ENV-001, section 3.

**`JAVA_HOME is not defined correctly` when running `mvn`.**
Set `JAVA_HOME` to the JDK folder (the folder that contains `bin`), not to the `bin` folder. Open a new terminal afterwards.

**`Address already in use: 8080`.**
Another program uses the port. On macOS and Linux run `lsof -i :8080`, on Windows `netstat -ano | findstr 8080`, then stop that process or change `server.port` in `application.properties`.

## Python

**`pip install` fails with an SSL certificate error on campus Wi-Fi.**
Use the campus mirror described in TS-ENV-002, section 4, with `trusted-host`.

**`ModuleNotFoundError` although the package is installed.**
You are probably in the wrong environment. Activate `.venv` and select it as the interpreter in VS Code.

## TypeScript and Node.js

**`EACCES: permission denied` when installing global packages.**
Do not use `sudo`. Install Node with `nvm` as described in TS-ENV-003, then retry.

**`pnpm: command not found`.**
Run `corepack enable` and open a new terminal.

## Git

**`Permission denied (publickey)` when pushing.**
Your SSH key is not registered in GitLab. Follow TS-ENV-004, section 2, and test with `ssh -T git@git.starit.example`.

**My commits do not appear in the contribution statistics.**
Check that `user.email` is your StarIT address.

## Network and portal

**The campus Wi-Fi network for students is called `StarIT-Student`.** Sign in with your student ID. Staff use `StarIT-Staff`.

**I cannot reach the portal from home.**
The portal is public. Git and the package mirrors are only reachable on campus or through the student VPN. Request VPN access from the helpdesk (TS-NET-009).

**ERR-PORTAL-403.**
You reached the limit of 3 registered devices. See TS-CRS-005, section 7.
