# StarIT Education Sample Data (English)

Everything here is **synthetic**. StarIT Education is a sample company; names, numbers, policies, URLs (`*.starit.example`) and the tax ID are invented. The policies are inspired by common practice in the IT training industry and do not describe any real company.

This data supports three things: demonstrating RAG and hybrid search, evaluating retrieval quality, and giving the Agent structured data to query.

## Contents

```
sample-data/
├── documents/            28 source documents, mixed formats (generated)
│   ├── hr/               10 files (recruitment, selection, onboarding, training, promotion, performance, leave, workload)
│   ├── finance/           8 files (expenses, travel, supplies, payroll, bonus, benefits, budget, invoices)
│   ├── tech-support/     10 files (Java/Python/TypeScript setup, Git, courseware, assignments, projects, FAQ, helpdesk, staff IT)
│   └── manifest.csv      metadata for ingestion: doc_id, version, status, access, campus_scope, format
├── structured/           7 CSV tables (campuses, employees, expense_claims, support_tickets, students, assignments, submissions)
├── demo-accounts.csv     the demo users: who they are in the data, their role, campus and job level
├── eval/
│   ├── qa-set.jsonl      54 questions about the documents, with expected answers and sources
│   └── sql-qa.jsonl      41 questions answerable from the CSV tables, each asked by a named account,
│                         with reference answers computed from the rows that account may see
├── _markdown-source/     editable Markdown sources of the documents
└── tools/
    ├── build_documents.py      Markdown -> docx / pdf / md / txt, writes manifest.csv
    └── generate_structured.py  deterministic CSV generator and SQL reference answers
```

## Retrieval challenges built into the documents

| Challenge | Example |
|---|---|
| Superseded version | `HR-REC-001` v1.0 (status `superseded`, referral bonus CNY 2,000) versus v2.1 (active, CNY 3,000) |
| Metadata filtering by campus | Meal subsidy and hotel limits differ by campus or city tier |
| Access control | `access` values: `all-staff`, `staff`, `students-and-staff`, `managers`, `hr-only`, `finance-and-hr` |
| Exact identifiers (keyword search wins) | `ERR-PORTAL-403`, `STC-2`, tax ID `91510000FAKE00001X`, document IDs |
| Paraphrased questions (vector search wins) | "Maven is painfully slow" versus the mirror instructions |
| Multi-document reasoning | Certification subsidy needs HR-TRN-004 plus FIN-REIM-001 approval levels |
| Calculation | Late penalty bands, overload pay, hotel nights times city limit |
| Unanswerable questions | Adoption leave, dress code, tuition fees are not in the documents |
| Tables and mixed formats | Policies contain tables; files come as docx, pdf, md and txt |

## Who can see what

Access has two parts, and they are controlled differently:

1. **Policy documents** exist once for the whole company, so they are controlled by **role** only (the `access` column in `documents/manifest.csv`). A campus does not change which policy a person may read.
2. **Structured data and campus materials** (student lists, tickets, submissions, expense claims, and in the future course slides and handouts) are controlled by **data scope**, which is the usual "data permission" idea in enterprise back offices: all data, own campus, or own records only.

### Policy documents: access by role

| Role | Can read documents with access |
|---|---|
| student | `students-and-staff` |
| staff | `all-staff`, `staff`, `students-and-staff` |
| manager | staff access plus `managers` |
| hr | manager access plus `hr-only`, `finance-and-hr` |
| finance | manager access plus `finance-and-hr` |

In `qa-set.jsonl`, `role` is the asker and `should_answer: false` means the assistant must refuse or say the information is not available. `Admin` and `RAGETLAdmin` are management roles with no document access of their own: managing the system or the knowledge base does not give the right to read restricted content.

### Structured data: data scope

| Role | employees, expense_claims | students, submissions, support_tickets | campuses, assignments |
|---|---|---|---|
| student | no access | own records | all |
| staff | own rows only | own campus | all |
| manager (campus director, department head) | own campus | own campus | all |
| hr, finance (headquarters functions) | all campuses | all campuses | all |
| Admin, RAGETLAdmin | no access | no access | all |

A support ticket belongs to the campus of the person who opened it.

## Job levels

Employees have a `level` made of a letter and a number. The letter is the career ladder:

| Letter | Ladder | Levels and typical titles |
|---|---|---|
| **I** | Instructor | I1 Junior Instructor, I2 Instructor, I3 Senior Instructor, I4 Lead Instructor, I5 Principal Instructor |
| **S** | Staff (support functions) | S1 Operations Assistant, S2 Admissions Advisor, Career Coach, Accountant, Helpdesk Engineer, S3 HR Business Partner |
| **M** | Management | M2 Department Head, Finance Controller, M3 Campus Director (the data has no M1) |

The three ladders cannot be compared directly, so a single **grade** (1 to 7) is defined for rules such as "grade 4 and above". A document can require a minimum grade (the AI module stores it as `min_level_rank`); it is not used by any sample document yet.

| Grade | Levels |
|---|---|
| 1 | S1, I1 |
| 2 | S2, I2 |
| 3 | S3, I3 |
| 4 | I4 |
| 5 | I5 |
| 6 | M2 |
| 7 | M3 |

This table is a demo convention for this project. Real companies keep their own grade-mapping table.

## Demo accounts

`demo-accounts.csv` lists the demo users. Each account is a real person in the CSV tables, so "own records" and "own campus" can be tested. The user name is `<given name>.<function>.<campus>`: for example `qing.hr.bj` is Qing Luo, HR, Beijing.

| Account | Role | Who in the data | Campus | Level (grade) |
|---|---|---|---|---|
| `wei.stu.sh` | student | student S0018 | SH | – |
| `ning.adm.bj` | staff | E0014, Admissions Advisor | BJ | S2 (2) |
| `wei.acad.sh` | staff | E0025, Instructor | SH | I2 (2) |
| `ling.mgr.bj` | manager | E0001, Campus Director | BJ | M3 (7) |
| `peng.mgr.sh` | manager | E0018, Campus Director | SH | M3 (7) |
| `qing.hr.bj` | hr | E0137, HR Business Partner | BJ | S3 (3) |
| `ning.fin.bj` | finance | E0138, Finance Controller | BJ | M2 (6) |
| `tao.admin.bj` | Admin | E0140, Helpdesk Engineer | BJ | S2 (2) |
| `min.ragetl.bj` | RAGETLAdmin | E0141, Principal Instructor | BJ | I5 (5) |

The headquarters functions (HR, Finance, IT, Academic Office) are in Beijing, the headquarters. All eight campuses are company-run; franchised campuses are out of scope.

## Structured data and the policies

The CSV data was generated to match the policies, with deliberate violations for the Agent to find: hotel claims above the nightly limit, entertainment above CNY 300 per person, teaching supplies above CNY 500 without pre-approval, claims submitted after 30 and after 90 days, tickets that missed their response target, and late submissions with penalties. `eval/sql-qa.jsonl` holds the reference answers.

Each question in `sql-qa.jsonl` names the `asker` (a demo account) and its `scope` (`company`, `campus`, `own` or `none`). The reference answer is computed only from the rows that account may see. Questions with `should_answer: false` (type `sql-scope`) ask for data outside the asker's scope, and the assistant must refuse or say it has no such data.

## Rebuilding

```bash
uv run python tools/build_documents.py            # docx via python-docx; pdf needs macOS and Google Chrome
uv run python tools/build_documents.py --only docx   # rebuild only the docx files
python3 tools/generate_structured.py   # standard library only
```

The vector database is **not** included yet. It will be produced by the ingestion pipeline once the embedding model is fixed, and shipped as a database dump plus a rebuild script.

## Chinese version

Planned for later. The same structure will be reused with Chinese documents.
