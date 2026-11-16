# StarIT Education 示例数据（英文数据）

[English](README.md)

这里的一切都是**合成的**。StarIT Education 是一家示例公司；名字、数字、制度、网址（`*.starit.example`）和税号都是虚构的。制度参考了 IT 培训行业的常见做法，不描述任何真实公司。

这份数据支持三件事：演示 RAG 和混合检索，评测检索质量，以及给 Agent 一份可以查询的结构化数据。

数据本身（文档、表格、评测题）是英文的；本文件只是说明它的中文翻译。

## 内容

```
sample-data/
├── documents/            28 份源文档，多种格式（生成的）
│   ├── hr/               10 份（招聘、遴选、入职、培训、晋升、绩效、休假、工作量）
│   ├── finance/           8 份（报销、差旅、物资、薪资、奖金、福利、预算、发票）
│   ├── tech-support/     10 份（Java/Python/TypeScript 环境、Git、课件、作业、项目、FAQ、helpdesk、员工 IT）
│   └── manifest.csv      入库用的元数据：doc_id、version、status、access、campus_scope、format
├── structured/           7 张 CSV 表（campuses、employees、expense_claims、support_tickets、students、assignments、submissions）
├── demo-accounts.csv     演示用户：他们在数据里是谁、角色、校区和职级
├── eval/
│   ├── qa-set.jsonl      114 道关于文档的题，带期望答案和来源
│   └── sql-qa.jsonl      41 道可以用 CSV 表回答的题，每题由一个指定的账号提问，
│                         参考答案只按该账号能看到的行计算
├── _markdown-source/     文档的可编辑 Markdown 源稿
└── tools/
    ├── build_documents.py      Markdown -> docx / pdf / md / txt，并写出 manifest.csv
    └── generate_structured.py  确定性的 CSV 生成器和 SQL 参考答案
```

## 文档里埋的检索难点

| 难点 | 例子 |
|---|---|
| 被取代的版本 | `HR-REC-001` v1.0（状态 `superseded`，推荐奖金 2,000 元）对比 v2.1（有效，3,000 元） |
| 按校区做元数据过滤 | 餐补和酒店限额随校区或城市档位不同 |
| 访问控制 | `access` 取值：`all-staff`、`staff`、`students-and-staff`、`managers`、`hr-only`、`finance-and-hr` |
| 精确编号（关键词检索占优） | `ERR-PORTAL-403`、`STC-2`、税号 `91510000FAKE00001X`、文档编号 |
| 改写的问法（向量检索占优） | "Maven 慢得要命"对比镜像设置说明 |
| 多文档推理 | 认证补贴需要 HR-TRN-004 加上 FIN-REIM-001 的审批级别 |
| 计算 | 迟交扣分档、超工作量津贴、酒店晚数乘城市限额 |
| 无法回答的问题 | 领养假、着装要求、学费不在文档里 |
| 表格和混合格式 | 制度里有表格；文件有 docx、pdf、md 和 txt |

## 谁能看到什么

访问控制分两部分，控制方式不同：

1. **制度文档**全公司只有一份，所以**只按角色**控制（`documents/manifest.csv` 里的 `access` 列）。校区不改变一个人能读哪份制度。
2. **结构化数据和校区资料**（学员名单、工单、提交记录、报销单，以及将来的课件和讲义）按**数据范围**控制，也就是企业后台里常见的"数据权限"：全部数据、本校区、或只有自己的记录。

### 制度文档：按角色访问

| 角色 | 能读的 access 值 |
|---|---|
| student | `students-and-staff` |
| staff | `all-staff`、`staff`、`students-and-staff` |
| manager | staff 的访问加上 `managers` |
| hr | manager 的访问加上 `hr-only`、`finance-and-hr` |
| finance | manager 的访问加上 `finance-and-hr` |

在 `qa-set.jsonl` 里，`role` 是提问者，`should_answer: false` 表示助手必须拒绝或说信息不可用。`Admin` 和 `RAGETLAdmin` 是管理角色，自己没有任何文档访问权：管理系统或知识库并不赋予读取受限内容的权利。

### 结构化数据：数据范围

| 角色 | employees、expense_claims | students、submissions、support_tickets | campuses、assignments |
|---|---|---|---|
| student | 无权访问 | 仅自己的记录 | 全部 |
| staff | 仅自己的行 | 本校区 | 全部 |
| manager（校区主任、部门负责人） | 本校区 | 本校区 | 全部 |
| hr、finance（总部职能） | 所有校区 | 所有校区 | 全部 |
| Admin、RAGETLAdmin | 无权访问 | 无权访问 | 全部 |

一张工单属于开单人所在的校区。

## 职级

员工有一个由字母和数字组成的 `level`。字母表示职业序列：

| 字母 | 序列 | 级别与典型职位 |
|---|---|---|
| **I** | 讲师序列（Instructor） | I1 初级讲师、I2 讲师、I3 高级讲师、I4 首席讲师、I5 资深首席讲师 |
| **S** | 职能序列（Staff，支持职能） | S1 运营助理、S2 招生顾问、职业辅导、会计、Helpdesk 工程师、S3 HR 业务伙伴 |
| **M** | 管理序列（Management） | M2 部门负责人、财务主管、M3 校区主任（数据里没有 M1） |

三个序列不能直接比较，所以定义了一个统一的**档**（1 到 7），用于"4 档及以上"这样的规则。文档可以要求最低档（AI 模块把它存为 `min_level_rank`）；目前没有样例文档使用它。

| 档 | 职级 |
|---|---|
| 1 | S1、I1 |
| 2 | S2、I2 |
| 3 | S3、I3 |
| 4 | I4 |
| 5 | I5 |
| 6 | M2 |
| 7 | M3 |

这张表是本项目的演示约定。真实公司有自己的职级对照表。

## 演示账号

`demo-accounts.csv` 列出了演示用户。每个账号都是 CSV 表里的一个真实的人，所以可以测试"自己的记录"和"本校区"。用户名是 `<名>.<职能>.<校区>`：例如 `qing.hr.bj` 是 Qing Luo，HR，北京。

| 账号 | 角色 | 数据里是谁 | 校区 | 职级（档） |
|---|---|---|---|---|
| `wei.stu.sh` | student | 学员 S0018 | SH | – |
| `ning.adm.bj` | staff | E0014，招生顾问 | BJ | S2（2） |
| `wei.acad.sh` | staff | E0025，讲师 | SH | I2（2） |
| `ling.mgr.bj` | manager | E0001，校区主任 | BJ | M3（7） |
| `peng.mgr.sh` | manager | E0018，校区主任 | SH | M3（7） |
| `qing.hr.bj` | hr | E0137，HR 业务伙伴 | BJ | S3（3） |
| `ning.fin.bj` | finance | E0138，财务主管 | BJ | M2（6） |
| `tao.admin.bj` | Admin | E0140，Helpdesk 工程师 | BJ | S2（2） |
| `min.ragetl.bj` | RAGETLAdmin | E0141，资深首席讲师 | BJ | I5（5） |

总部职能（HR、财务、IT、教务办）在总部北京。八个校区都是公司直营；加盟校区不在范围内。

## 结构化数据与制度

CSV 数据按制度生成，并刻意埋了违规，让 Agent 去发现：超过每晚限额的酒店报销、人均超过 300 元的招待费、没有事先批准的超过 500 元的教学物资、超过 30 天和超过 90 天才提交的报销、没达到响应目标的工单，以及带扣分的迟交作业。`eval/sql-qa.jsonl` 里有参考答案。

`sql-qa.jsonl` 里的每道题指明了 `asker`（一个演示账号）和它的 `scope`（`company`、`campus`、`own` 或 `none`）。参考答案只按该账号能看到的行计算。`should_answer: false`（类型 `sql-scope`）的题问的是提问者范围之外的数据，助手必须拒绝或说没有这样的数据。

## 重新生成

```bash
uv run python tools/build_documents.py            # docx 用 python-docx；pdf 需要 macOS 和 Google Chrome
uv run python tools/build_documents.py --only docx   # 只重新生成 docx 文件
python3 tools/generate_structured.py   # 只用标准库
```

向量库**还没有**随附。等嵌入模型确定后，由入库管线生成，并以数据库转储加重建脚本的形式提供。

## 中文版数据

以后再做，会沿用同样的结构，换成中文文档。
