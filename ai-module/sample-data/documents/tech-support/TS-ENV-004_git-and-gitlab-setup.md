---
doc_id: TS-ENV-004
title: Git and Campus GitLab Setup
domain: tech-support
version: 2.2
status: active
effective_date: 2026-02-01
access: students-and-staff
campus_scope: all
format: md
---

# Git and Campus GitLab Setup

All course code, assignments and projects are stored in the StarIT GitLab at `https://git.starit.example`.

## 1. Sign in

Sign in with your student ID and the same password as the course portal (single sign-on). Staff use their company account.

## 2. Create an SSH key

Use the ed25519 type:

```
ssh-keygen -t ed25519 -C "your.studentID@starit.example"
```

Press Enter to accept the default file location. Copy the content of `~/.ssh/id_ed25519.pub` and paste it in GitLab under Preferences > SSH Keys. Test with `ssh -T git@git.starit.example`. You must see "Welcome to GitLab".

## 3. Configure Git

```
git config --global user.name "Your Name"
git config --global user.email "your.studentID@starit.example"
git config --global init.defaultBranch main
```

Use your StarIT email address. Commits made with another address are not counted in the contribution statistics for projects (see TS-PRJ-007).

## 4. Repository names

Course repositories are created by the instructor from a template. Student repositories follow the pattern `<cohort>-<studentID>-<course>`, for example `2026S1-BJ20260123-java`. Do not rename them, because the autograder finds repositories by name.

## 5. Commit messages

Write the subject line in the imperative mood, at most 72 characters, for example "Add login validation". Use a prefix: `feat:`, `fix:`, `docs:`, `test:` or `refactor:`.

## 6. Branch rules

The `main` branch is protected. Nobody can push to `main` directly in team projects; changes go through merge requests (see TS-PRJ-007). In personal assignment repositories you may push to `main`.

## 7. Large files

Do not commit files larger than 50 MB, such as datasets or videos. Use the course portal for large files. Never commit passwords, API keys or `.env` files.
