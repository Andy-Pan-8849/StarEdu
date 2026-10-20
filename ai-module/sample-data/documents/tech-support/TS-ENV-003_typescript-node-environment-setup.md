---
doc_id: TS-ENV-003
title: TypeScript and Node.js Development Environment Setup
domain: tech-support
version: 2.6
status: active
effective_date: 2026-02-01
access: students-and-staff
campus_scope: all
format: md
---

# TypeScript and Node.js Development Environment Setup

This guide is for students of the TypeScript Full-Stack Bootcamp.

## 1. Required versions

| Tool | Version |
|---|---|
| Node.js | 22 LTS |
| Package manager | pnpm 9 |
| TypeScript | 5.x (installed per project) |
| Editor | Visual Studio Code with ESLint and Prettier extensions |
| Database for the course | PostgreSQL 16 |

## 2. Install Node.js with a version manager

Use a version manager so that you can switch Node versions between projects.

- macOS and Linux: install `nvm`, then run `nvm install 22` and `nvm use 22`.
- Windows: install `nvm-windows`, then run `nvm install 22.11.0` and `nvm use 22.11.0`.

Check with `node -v` (must print v22.x). Do not use `sudo` to install global npm packages.

## 3. Install pnpm and set the campus registry

```
corepack enable
corepack prepare pnpm@9 --activate
pnpm config set registry https://npm.starit.example/
```

## 4. Create the first project

```
pnpm create next-app@latest hello-star --typescript --tailwind --eslint
cd hello-star
pnpm dev
```

Open http://localhost:3000. The default Next.js page must appear. The backend course uses NestJS, installed with `pnpm add -g @nestjs/cli`. The NestJS dev server runs on port 4000 in the course template.

## 5. Editor settings

Enable "Format on Save" with Prettier. In every project, TypeScript must run in strict mode (`"strict": true` in `tsconfig.json`). The autograder rejects projects with strict mode turned off.

## 6. PostgreSQL

Install PostgreSQL 16 with the default port 5432 and create the database `starit_course`. Use Prisma for database access in the course, as shown in week 9.

## 7. Verify

Clone `https://git.starit.example/ts/env-check.git`, run `pnpm install` and `pnpm test`. All tests must pass.
