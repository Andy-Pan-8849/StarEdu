# Blueprint requirements: traditional business + AI capability (Enterprise Knowledge Assistant + Agent)

[中文](project-requirements.chn.md)

- Status: **Draft v0.2, requirements being clarified, not yet approved, no code generated yet**
- Date: 2026-10-19
- Marking convention: [User decision] = the user clearly said so; [My proposal] = Claude's guess or suggestion, awaiting the user's confirmation; [To verify] = a fact not confirmed by an official source

---

## 1. Purpose of the project

1. To show the user's own engineering ability (a portfolio).
2. To be a blueprint for AI application development in small and medium enterprises, open-sourced on GitHub for others to learn from and develop further.

## 2. Overall composition (three sub-projects, in order)

| Order | Sub-project | Description |
|---|---|---|
| 1 | AI engineering project | RAG ETL engine + RAG + agent (FastAPI, MCP server, PostgreSQL + pgvector, Next.js front end) |
| 2 | Enterprise back-office project | Rebuilt in TypeScript to the requirements of an open-source competitor: Next.js 15 + Tailwind + shadcn/ui + NestJS |
| 3 | Full observability | Prometheus, Grafana, Loki, Tempo, OpenTelemetry; Langfuse local only |

[User decision] Do the AI project first, then the enterprise back office. The two systems are demonstrated at different entry URLs.
[My proposal] Design the namespaces, ingress and database split as two systems from day one, to avoid rework.

## 3. Reference architecture diagram

- File: `Documents/my_document/others/TempFiles/interview_arch_traditional_plus_ai_v2.png` (the NestJS version, the baseline diagram specified by the user)
- There is also `interview_arch_springboot_plus_ai.png` (a Spring Boot comparison version, not adopted by this project)
- Layers in the diagram: browser → edge/reverse proxy + Keycloak → Next.js (3000) / NestJS (4000) / FastAPI (8000) → agent layer → MCP server → LLM gateway → data layer → observability and deployment

## 4. Two-profile strategy

[User decision] Adopt a full profile + a lite profile, from the same code, told apart by Helm values / Compose profiles.

- **full profile**: runs locally (the user has at least 100 GB of disk locally) and implements the architecture diagram as completely as possible.
- **lite profile**: deployed on Oracle Always Free for an online demo, with lightweight substitutes.

### 4.1 Trade-offs already decided

| Item | Decision |
|---|---|
| ArgoCD, Vault, Sentry | [User decision] Not for now, to be done later if work needs it |
| Local vLLM | [User decision] Not deployed; connect directly to OpenAI and Anthropic (the user has bought APIs from both) |
| Langfuse v3 | [User decision] Used locally only, not deployed to Oracle |
| RAG ETL engine | [User decision] Wanted; if too big, deployed locally only and not on Oracle (see section 6) |
| Keycloak | [User decision] The Java version is acceptable, as long as it works together (see section 7) |
| Deployment | [User decision] Local Docker Compose for development; k3s on the server |
| Mobile app | [My proposal] Not done |
| Front-end framework | [My proposal] Next.js 15 + Tailwind + shadcn/ui throughout (the React SPA in the diagram is not built separately), to be confirmed |

### 4.2 Lightweight substitutes in the lite profile ([My proposal], to be confirmed)

| Component of the architecture diagram | lite (Oracle) | full (local) |
|---|---|---|
| Kafka | Redis Streams or a Postgres outbox table | Kafka |
| Elasticsearch | Postgres full-text search + pgvector hybrid search | Elasticsearch |
| Redis Cluster | A single-node Redis | Redis (Sentinel optional) |
| MinIO | Oracle Object Storage (S3 compatible, free quota [to verify]) or a single-node MinIO | MinIO |
| Langfuse | Not deployed | Deployed (v3 ships its own ClickHouse, which is heavy) |
| Observability | Prometheus, Grafana, Loki, Tempo, OTel kept (possibly with shorter retention) | The full set |
| LLM gateway | LiteLLM forwarding to OpenAI / Anthropic | Same |
| Keycloak | Open (see 7) | Keycloak |
| RAG ETL engine | Lightweight parsing + a preset sample corpus (see 6) | The full engine |

## 5. Deployment target: Oracle Always Free

- Specification quoted by the user: Arm Ampere A1, 1,500 OCPU hours and 9,000 GB hours per month, 12 GB of memory, usable as 1 or 2 VMs.
- [To verify] Online reports say that in June 2026 Oracle lowered the A1 quota from 4 cores 24 GB to 2 cores 12 GB without an announcement; another unconfirmed claim says that after upgrading to Pay As You Go the 4 cores 24 GB may still be available. Oracle's official page returned 403 to automated fetching, so it could not be checked. **The user needs to confirm the actual quota in their own account.**
- Idle reclamation: an instance whose P95 of CPU, network and (for A1) memory stays under 20% for 7 days may be reclaimed.
- [My proposal] Open only 1 VM (2 OCPU / 12 GB), single-node k3s, Traefik (bundled with k3s) routing by domain name, cert-manager for certificates, two namespaces for the two systems, and your own domain name is needed.
- Every image must have an arm64 version.
- Single point of failure risk: a rebuild script and backups are needed.
- Alternative (not free): Hetzner ARM instances, price [to verify]. Among free alternatives there is no permanently free option with more memory than Oracle's (GCP e2-micro has only 1 GB).

### 5.1 Memory budget of the lite profile (rough, [My proposal], to be measured)

| Component | About GB |
|---|---|
| k3s | 0.5 to 1 |
| PostgreSQL + pgvector | 1 to 2 |
| FastAPI + MCP + two Next.js + NestJS | 2 to 3 |
| Redis | 0.2 |
| Observability (Prometheus, Grafana, Loki, Tempo, OTel) | about 2 |
| IdP (if Keycloak, including its own use) | about 1 to 1.5 |
| Total | about 7 to 10, with very little headroom |

Conclusion: 12 GB can hold lite but with nothing to spare; Keycloak and the RAG ETL engine are the biggest uncertainties.

## 6. RAG ETL engine (to be decided)

Purpose: take documents such as PDF, Word and TXT as input and show RAG capability (parse → chunk → embed → store).

Candidates (sourced from aggregation and review web pages, lacking hard resource data, **to be measured on the user's real documents before choosing**):

| Candidate | Positioning | Resources | Notes |
|---|---|---|---|
| RAGFlow | A complete RAG engine (with deep document understanding, knowledge bases, UI) | The heaviest, the reference suggests 4 cores or more and 16 GB of memory | Apache 2.0; ships a whole set of services, overlapping in function with this project's own RAG + agent |
| Docling (IBM) | A document conversion toolkit: PDF, DOCX, PPTX, HTML, images → Markdown/JSON | Relatively light (no hard data) | Apache 2.0; suitable as a parser in the pipeline |
| Unstructured | Parsing + many formats and connectors | Depends on the dependencies enabled; the open-source version's dependencies are heavy | Wide format coverage |

[My proposal] (to be confirmed):
1. **Write the ETL pipeline ourselves** (FastAPI + a background worker: parse → clean → chunk → embedding → write to pgvector), with pluggable parsers. What is shown is engineering ability, not installing a ready-made product.
2. The full profile uses **Docling** for parsing (high quality, supports layout and tables).
3. The lite profile uses lightweight parsers (such as pymupdf, python-docx, plain text), with **sample documents and a ready-built vector store preset** on Oracle, so that uploading a small file on the spot also works.
4. RAGFlow is not integrated and is only mentioned in the documents as a "benchmark product"; if the user wants to see it, it can be run separately locally.

## 7. Authentication (the Keycloak question)

- Keycloak is implemented in Java (Quarkus) and has no TypeScript version.
- Resources: a 2026 review says a single node plus PostgreSQL uses about 1.5 GB when idle and takes 60 to 90 seconds to start; Authentik about 0.6 to 0.8 GB.
- Alternatives implemented in TypeScript: Logto (TypeScript, MPL 2.0, OIDC / OAuth 2.0), with no reliable memory data, to be measured. Zitadel is Go.
- [My proposal] (to be confirmed):
  1. Depend only on standard OIDC / JWKS in the architecture: NestJS and FastAPI both verify the same JWT through JWKS, so the IdP can be replaced.
  2. The full profile uses Keycloak (the industry standard, with résumé value).
  3. Whether the lite profile also uses Keycloak is decided after measuring memory; alternatives are Logto, or NestJS issuing JWTs itself (also through JWKS).

## 8. Technology stack summary

- Front end: Next.js 15, Tailwind, shadcn/ui
- Traditional business back end: NestJS (TypeScript), with the ORM Prisma or TypeORM per the diagram ([Open])
- AI back end: FastAPI, LangGraph (in the diagram), MCP server, LiteLLM
- Data: PostgreSQL + pgvector, Redis, object storage
- Deployment: Docker Compose (development), k3s + Helm (server)
- Observability: Prometheus, Grafana, Loki, Tempo, OpenTelemetry; Langfuse (local only)

## 9. List of open questions

1. Is the lite / full trade-off table (4.2) accepted entirely?
2. Is the RAG ETL plan (the proposal of section 6) accepted?
3. What IdP should the lite profile use (section 7)?
4. The actual quota of the Oracle account (the user verifies).
5. Is there a domain name already?
6. The functional scope of the enterprise back office (which modules of the open-source competitor: users, roles, menus, departments, dictionaries, logs, scheduled jobs and so on): not discussed yet.
7. The demo scenario and sample data of the AI project (which documents, which business questions): not discussed yet.
8. The GitHub repository structure (monorepo or several repositories) and the license: not discussed yet.
9. The ORM choice, and whether the front end needs other UI constraints: not discussed yet.

## 10. Process conventions

- No code is generated and no resource is downloaded or installed before all requirements are confirmed.
- After the requirements are confirmed: write the formal design documents → the user approves → write the implementation plan → then start work.
- This document is updated with the discussion and kept as the basis for later checking.

---

## 11. Update log

### 2026-10-19, round 2

[User decisions]
- Cost strategy: buy rather than build when possible; there is no domain name for now, and save where possible.
- The AI project focuses on **agent development**; in RAG the focus is **hybrid search**, to master its principles.
- First deploy **RAGFlow** locally as a way to learn and benchmark; the project itself uses "FastAPI + a background worker with a self-built ETL pipeline and pluggable parsers" to keep the size down.
- Wants "preset sample documents and a vector store" prepared: against the background of a national multi-campus IT training company, synthesise sample data in three domains: HR (recruitment, training, selection, promotion), Finance (expense claims, payroll, benefits) and Technical Support (Java/Python/TS environment setup, courseware download, assignment submission, student project collaboration rules). **Before starting, the user decided that the plan is to be explained first (see below).**

[My proposals] (to be confirmed)
- Domain name: not required. A public IP + different ports can be used, or a free subdomain (DuckDNS / sslip.io), or a domain at about US$10 a year can be bought.
- Search: Elasticsearch itself has BM25 + dense_vector + hybrid ranking, but in this project lite uses Postgres (pgvector + full-text search + RRF in the application layer) to hand-write hybrid search and learn the principles; the searcher is made pluggable, and the full profile can add Elasticsearch / OpenSearch for comparison. Chinese needs word segmentation (jieba and the like).
- The sample company is a **fictitious** enterprise, and the names and materials of real companies such as Tarena (达内), Itheima (黑马) and Qingniao (青鸟) are not used.
- The sample includes: source documents (several formats), an evaluation question set, structured business data (which can also seed the enterprise back office and the SQL agent), a pre-built vector store dump and a rebuild script.

### 2026-10-19, round 3

[User decisions]
- When no domain name is used, telling entries apart by different ports is also fine; an open-source project must not fail to run because a domain name expired.
- The sample data is made in **English** first, and the Chinese version later.
- The fictitious company name: **星辰 IT 教育 / StarIT Education**.
- Create the project directory `starit-enterprise-ai-blueprint/`, divided into `ai-module/` (AI module material) and `business-module/` (traditional business module material); create README.md in the root recording features and architecture decisions.
- Generate the sample data now and keep it under the AI module directory for later use.

[Done]
- The sample data is in `ai-module/sample-data/`: 28 English documents (docx, pdf, md and txt mixed), 7 structured CSV tables, 54 document Q&A + 16 SQL Q&A, and repeatable generation scripts.
- The vector store has **not been generated yet**: it is produced by the pipeline once the ETL pipeline and the embedding model are decided.

[My proposals]
- Default configuration: localhost plus a port; the Oracle demo site first uses the public IP plus a port; a domain name and HTTPS are optional, with the domain set by an environment variable.
- Embedding uses the OpenAI embeddings API (billed separately, not self-hosted); the model choice is to be confirmed.

### 2026-10-19, round 4

[User decisions]
- The embedding model is `text-embedding-3-small`; the model and provider are configurable variables, so switching to a self-hosted or another model later only changes variables.
- The Oracle public IP is set as a "reserved IP" (the user does this in the Oracle console).
- DuckDNS is used first as an optional free domain name; the priority of the entry address: use the domain name if configured, otherwise the public IP if configured, otherwise the local default (localhost + port). The installation and deployment part of the README must explain all three ways, and a learner may use only local.
- Which modules of the open-source competitor the enterprise back office will build: to be discussed with the user later, and the AI part comes first.
- The ORM for NestJS is **Prisma**.
- Definition of the lite profile: deployed on Oracle for employers to visit and see engineering ability; larger components such as Langfuse are not deployed.

[My proposals] (to be confirmed)
- Configuration: Docker Compose uses `.env` (with an `.env.example` provided; the real `.env` stays out of Git), k3s uses Helm values + a Secret, and the variable names are kept the same on both sides. Secrets (API keys) go only in `.env` or a Secret.
- Embedding variables: `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`. Changing the model means the vector dimension may change, and data already ingested must be embedded again; at ingestion the model name and dimensions used are recorded on every chunk.
- Prisma manages only NestJS's tables; the FastAPI side uses its own migration tool; the two sides use different schemas of the same Postgres instance, to avoid overwriting each other.
- GitHub: a single repository (monorepo), created early, private at first and made public after checking; the suggested license is MIT (or Apache-2.0).
- I found no official statement on DuckDNS's validity period or whether it reclaims names after long inactivity, and the user should read the notes on duckdns.org; do not promise "one year" in the documents.

[To do]
- Whether to deploy the lite profile's login system (Keycloak takes about 1.5 GB of memory on Oracle) is decided after the AI part is done and the memory measured.
- The user checks the sample data and gives feedback.

### 2026-10-31, round 5 (design requirements after the RAGFlow trial)

[User decision]
- The agent flow must have **explicit End states**. Reason: RAGFlow's agent canvas has only a start component and no end component, so from the picture one cannot tell where the flow ends, nor whether an ending is normal or a missing connection.

[My proposals] (details to be confirmed)
- Every path of the self-built agent (LangGraph) ends with a named End node, and "no downstream means finished" is not allowed.
- Every End carries a **reason code**, for example `answered`, `need_role`, `no_permission`, `not_found`, `error`.
- When a run ends, the End name and reason code are written to the trace (Langfuse) and the business log, to debug and to count "how many questions went unanswered".
- The visualisation of the flow chart (in documents or the front end) must also draw the End nodes.
- A related lesson is also recorded: in a multi-turn conversation, "waiting for the user to add something" and "a new question" must be told apart by an explicit conversation state (such as `clarifying` / `answering`) and not by implicit variables such as `sys.query`; identity and permission come from the login information and are not judged by the LLM.

### 2026-10-31, round 6 (permission design, to be confirmed)

[Background] The user asked about industry practice for enterprise document permissions in a RAG assistant. RAGFlow's permissions are at the dataset level, with no filtering by document or by user, so it is only used for learning and benchmarking and is not StarEdu's permission scheme. The following is the scheme I give from existing knowledge, not checked online.

[My proposals] (to be confirmed)
1. **Model combination**: RBAC sets the broad scope (role / department), ABAC narrows it with attributes (grade, campus, classification), and an ACL names individuals for a few sensitive files. A single RBAC is not used.
2. **Document metadata**: at ingestion every document gets `department`, `sensitivity` (public / internal / confidential / restricted), `allowed_roles`, optional `allowed_users`, `min_level`, `campus`, `status` / `version`. Chunks inherit all permission fields of their document.
3. **Source of identity**: the claims of the JWT issued by Keycloak (role, department, grade). Identity is neither stated by the user in the chat nor judged by the LLM.
4. **Where it is enforced**: the search layer filters inside the database query (pgvector's metadata conditions + full-text search conditions, with Postgres row-level security RLS as an optional double safeguard), **filtering first and then ranking and fusing**; only chunks that pass the filter enter the prompt; when there is no result the answer is "no permission or not found" and the model is not allowed to make things up.
5. **Derived content inherits permissions**: summaries, questions and keywords generated at ingestion inherit the original document's permissions.
6. **Cache and memory**: the key of an answer cache carries the permission dimension; conversation memory stores only stable user preferences and never content from restricted documents.
7. **Refusal wording**: a refusal does not reveal restricted content.
8. **Audit**: record the user, time, query and the ids of the documents hit, written to the log and the trace.
9. **Permission changes**: an employee's transfer or departure must take effect promptly; in the sample this is done by events or periodic synchronisation, the exact way to be decided.
10. **Tests**: use the `access` questions of the evaluation set (such as DOC-45 / DOC-46: the same salary question, which HR should answer and a student should be refused) as permission regression tests, and add the two kinds of cases "statistical questions" and "cross-user cache".

[Permission decision rules] (my proposal, to be confirmed)
- **How the ACL is stored**: one grant per row, with the columns `file id / subject type (user, role, group) / subject / permission`, and no "one column per person". At search time it checks whether the current user's identity, roles and groups intersect with the file's grants; the list of subjects can also be stored as an array field on the chunk, with the same effect.
- **Stacking several models is not all AND** but three rules:
  1. Grants are OR: a role grant, an ACL naming, a relationship grant; any one holding counts as authorised.
  2. Mandatory constraints are AND: classification not above the user's clearance, file status valid, account not disabled, campus scope matching; all must hold together.
  3. An explicit denial takes priority: when there is a clear prohibition (such as resignation or a blacklist), other grants are void.
- Formula: `accessible = (role grant OR ACL grant OR relationship grant) AND mandatory constraints AND NOT explicit denial`.
- Example: an employee of the HR role viewing a restricted-level salary file has the role grant, but their clearance only reaches confidential, the mandatory constraint fails, and access is refused; a finance manager named by the ACL is not of the HR role, but the grant holds and the constraints are met, so access is allowed.

[To be confirmed]
- Whether grade and campus are included in the sample's permission attributes (the sample data now has only a split at the role level).
- Whether to enable Postgres RLS.
- Whether the "assigned to individuals" case of a few files is to be demonstrated in the sample.

### 2026-11-02, round 7 (AI module feature list v1)

The RAGFlow trial is over. The following is the feature list of the AI module, confirmed item by item by the user. It has two phases: finish the AI part first, then go back to the traditional business part.

[User decisions]
- Phase 2 (P1): streaming output, write action confirmation, memory, cost and latency statistics. **Rerank is the exception and goes in phase 1.**
- The first MCP server tools: document search, course and student data queries (read-only), expense status queries.
- SQL agent permissions: a read-only account + allow-listed tables + row-level conditions.
- The document management page is in phase 1 and is not replaced by scripts.
- Memory and write action confirmation are both kept and not deleted.

**Phase 1**
- A Knowledge base and ETL: document upload and ingestion jobs (docx, pdf, md, txt); pluggable parsers and configurable chunking, with chunks recording source, page or heading path; document metadata (department, classification, allowed roles, version and status, campus); embedding configured through variables, with chunks recording model and dimensions; summaries, questions and keywords as extra fields, with the original text always kept in the full-text index and inheriting permissions; ingestion status, failure reasons and retries visible.
- B Search: Postgres full text + pgvector + RRF in the application layer; filtering by permission and version inside the database before ranking; **rerank**; a pluggable searcher interface; evaluation of exact-code queries.
- C Employee assistant: Q&A with citations; conversations created by the user, not expiring automatically, summarised or truncated when the context is too long; saying clearly when there is no permission, nothing is found or it is uncertain, without making things up or leaking.
- D Agent: a fixed outer flow + local agents; tools are document search, read-only SQL and MCP business tools; every run ends with an explicit End state with a reason code; an explicit conversation state is used when more information is needed.
- E Identity and permissions: Keycloak JWT + JWKS; the permission decision (grants OR, mandatory constraints AND, explicit denial first); an audit log.
- G Evaluation and observability: run the evaluation set automatically (54 document Q&A, 16 SQL Q&A) and output accuracy and permission regression results; Langfuse (local only), OpenTelemetry, Prometheus, Grafana, Loki.
- H Front end and deployment: a Next.js chat page, conversation list, citation display, document management page; Docker Compose (full) and k3s (lite); one-command import of the sample data.

**Phase 2**
- Streaming output; write actions needing user confirmation; memory (storing only stable user preferences and facts, no restricted document content, not for audit); cost and latency statistics (per model, per conversation).

[Next step]
- By the process: requirements confirmation → formal design documents → user approval → implementation plan → development. No application code is written before the design documents are approved.
- The design documents have to answer: the code repository structure (monorepo directories), the database schema, the API contract, the agent flow chart (with End states), the permission metadata fields, the evaluation plan, the differences between the two profiles.

### 2026-11-02, round 8 (technology choices confirmed)

[User decisions]
- Python: **uv** for package management, **Python 3.12**.
- Agent orchestration: **LangGraph**.
- Permissions of the document management page: handled by Admin first; a role **RAGETLAdmin** is added to the permission system, and people with this role manage the knowledge base documents (upload, delete, re-ingest).

[My understanding] (to be confirmed) Admin creates users and assigns roles (including granting RAGETLAdmin) and, as a super role, also holds all permissions; day-to-day document management is done by RAGETLAdmin.

[Next step] The formal design documents go in `docs/design/`, split into files by topic, one confirmed after another is written.

### 2026-11-02, round 9 (roles and business scope)

[User decisions]
- The business scope is **company-run campuses** only for now: all 8 campuses in the sample are treated as run by the headquarters; franchised campuses (independently managed) are out of scope, and permissions keep `campus_id` for future extension.
- No `SchoolAdmin`; a campus manager = `manager` + the `campus_id` attribute.
- `Admin` manages only users, roles and system configuration and **does not read restricted document content by default**; `RAGETLAdmin` manages the knowledge base documents.
- 7 roles in all: `student`, `staff`, `manager`, `hr`, `finance`, `Admin`, `RAGETLAdmin`.
- The 5 confirmation points of design document 01: the first 4 accepted, the 5th revised by this round.
- Confirm with the user before generating code.

### 2026-11-02, round 10 (data scope, grades and accounts, M2 checklist confirmed)

[User decisions]
- Three database accounts: `starit` (owner), `ai_app` (application), `ai_sql_ro` (read-only, cannot log in).
- **Two kinds of access control**: policy documents exist once for the whole company and are controlled by role only, regardless of campus; structured data and campus materials (student lists, courseware, handouts and so on) are controlled by data scope (whole company / own campus / own records only). `hr` and `finance` (headquarters functions) have whole-company scope; "an employee sees only their own campus". The sample data and the evaluation set were changed accordingly.
- The headquarters functions (HR, Finance, IT, Academic Office) are at the Beijing headquarters; all campuses are company-run and franchised campuses are out of scope.
- Demo accounts are named `<given name>.<function>.<campus>`, matching real people in the sample data.
- The grade table (1 to 7): S1, I1 = 1; S2, I2 = 2; S3, I3 = 3; I4 = 4; I5 = 5; M2 = 6; M3 = 7. The meaning is to be written in the README (written).
- Row filtering first uses a `WHERE` in the view, not RLS.

[To do] The sample data currently has no campus-specific material (courseware, handouts). It is planned to add a few when the evaluation set is expanded (M8, or earlier), to test the document permissions of campus scope.
