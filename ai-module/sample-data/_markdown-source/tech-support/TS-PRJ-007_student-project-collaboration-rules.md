---
doc_id: TS-PRJ-007
title: Student Project Collaboration Rules
domain: tech-support
version: 2.5
status: active
effective_date: 2026-02-01
access: students-and-staff
campus_scope: all
format: pdf
---

# Student Project Collaboration Rules

These rules apply to the capstone project in weeks 13 to 16 and to all team projects before that.

## 1. Teams

A team has 3 to 5 students. The instructor forms the teams in week 12 and tries to mix skill levels. Teams may not be changed after week 13 without the instructor's approval.

## 2. Roles

Each team chooses a project lead who coordinates the work. The role rotates every 2 weeks. Every member also owns one area, for example frontend, backend, database or testing.

## 3. Git workflow

1. The `main` branch is protected. Nobody pushes to it directly.
2. Work happens on feature branches named `feat/<short-name>` or `fix/<short-name>`.
3. Each change goes through a merge request that needs at least **1 approval** from another team member.
4. The autograder pipeline must pass before a merge request can be merged.
5. Commit with your StarIT email, otherwise your commits are not counted.

## 4. Minimum contribution

Each member must have at least **10 merged commits** and must review at least 5 merge requests of teammates during the project. Members below these numbers receive an individual deduction.

## 5. Checkpoints

The instructor holds a checkpoint every 2 weeks. At the checkpoint, the contribution statistics are shown to the team. A member with very low contribution gets a written warning at the second checkpoint.

## 6. Grading

| Part | Weight |
|---|---|
| Team grade (product, code quality, tests, documentation) | 70 percent |
| Individual grade (commits, merge request reviews, peer review) | 30 percent |

Peer review is a short anonymous form that each member fills in during week 16.

## 7. Deliverables

- A running application and the source repository
- A README with setup steps and an architecture overview
- A 5-minute demo video
- A live demo of 10 minutes at Demo Day in **week 16**

## 8. Rules for code and data

Use only open-source libraries with a license that allows reuse, and name them in the README. Do not put secrets or personal data in the repository. Use of AI coding tools follows the disclosure rule in TS-HW-006.

## 9. Conflicts

If a team conflict cannot be solved internally, ask the instructor. The instructor may reassign tasks or, in serious cases, move a member to an individual project.
