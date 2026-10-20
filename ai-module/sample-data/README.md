# StarIT Education Sample Data (English)

Everything here is **synthetic**. StarIT Education is a fictional company; names, numbers, policies, URLs (`*.starit.example`) and the tax ID are invented. The policies are inspired by common practice in the IT training industry and do not describe any real company.

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
├── eval/
│   ├── qa-set.jsonl      54 questions about the documents, with expected answers and sources
│   └── sql-qa.jsonl      16 questions answerable from the CSV tables, with reference answers computed by the generator
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

## Access model used by the evaluation set

| Role | Can read documents with access |
|---|---|
| student | `students-and-staff` |
| staff | `all-staff`, `staff`, `students-and-staff` |
| manager | staff access plus `managers` |
| hr | manager access plus `hr-only`, `finance-and-hr` |
| finance | manager access plus `finance-and-hr` |

In `qa-set.jsonl`, `role` is the asker and `should_answer: false` means the assistant must refuse or say the information is not available.

## Structured data and the policies

The CSV data was generated to match the policies, with deliberate violations for the Agent to find: hotel claims above the nightly limit, entertainment above CNY 300 per person, teaching supplies above CNY 500 without pre-approval, claims submitted after 30 and after 90 days, tickets that missed their response target, and late submissions with penalties. `eval/sql-qa.jsonl` holds the reference answers.

## Rebuilding

```bash
python3 tools/build_documents.py       # needs macOS textutil and Google Chrome for docx and pdf
python3 tools/generate_structured.py   # standard library only
```

The vector database is **not** included yet. It will be produced by the ingestion pipeline once the embedding model is fixed, and shipped as a database dump plus a rebuild script.

## Chinese version

Planned for later. The same structure will be reused with Chinese documents.
