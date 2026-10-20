# StarEdu · StarIT Enterprise AI Blueprint（星辰 IT 教育 · 传统业务 + AI 融合样板工程）

> 状态：**需求澄清阶段的工作稿**。尚无应用代码，只有需求文档和样例数据。内容随讨论更新，最终整理后再作为正式 README 发布。
> 未经用户确认的内容一律标为【建议】。

## 1. 这是什么

一个面向中小企业的"传统业务系统 + AI 能力"样板工程，同时用来展示作者的工程能力。以虚构的全国连锁 IT 培训企业 **StarIT Education（星辰 IT 教育）** 为业务背景，分两个模块：

| 模块 | 目录 | 内容 | 顺序 |
|---|---|---|---|
| AI 模块 | [ai-module/](ai-module/) | 企业知识助手（RAG，重点是 hybrid search）+ Agent（重点）+ MCP Server + 自建 RAG ETL 管线 | 先做 |
| 传统业务模块 | [business-module/](business-module/) | 按开源竞品需求，用 TypeScript 重做的企业后台：Next.js 15 + Tailwind + shadcn/ui + NestJS | 后做 |
| 可观测性 | 两个模块共用 | Prometheus、Grafana、Loki、Tempo、OpenTelemetry；Langfuse 仅本地 | 随模块逐步加入 |

参考架构图（本机）：`Documents/my_document/others/TempFiles/interview_arch_traditional_plus_ai_v2.png`。

## 2. 已确定的决定（用户）

- 本地用 Docker Compose 开发；服务器用 **k3s**，部署在 **Oracle Always Free**（Arm）。两个系统用不同入口演示。
- **Full profile + Lite profile**：同一份代码，full 在本地跑完整架构，lite 部署到 Oracle 做在线演示。
- 不做：ArgoCD、Vault、Sentry、本地 vLLM、移动端 App。LLM 直接调用 OpenAI 和 Anthropic。
- Langfuse v3 只在本地使用，不部署到 Oracle。
- 成本策略：能买就不自己做。AI 部分重点是 **Agent**；RAG 部分重点是 **hybrid search**，要掌握原理。
- RAG ETL：本地先部署 **RAGFlow** 学习对标；项目内**自建管线**（FastAPI + 后台 worker：解析、清洗、分块、向量化、写入 pgvector），解析器可插拔。
- Keycloak 的 Java 版可以接受，能联合工作即可。
- 暂无域名，能省则省；开源项目默认不依赖域名（用端口区分入口）。
- 样例业务：虚构公司 **StarIT Education（星辰 IT 教育）**，覆盖 HR、Finance、Technical Support 三个领域；**先做英文版**，中文版以后再做。
- Embedding：`text-embedding-3-small`（OpenAI），提供方、模型名、维度都做成变量，换模型只改变量（换后需重新入库）。
- 入口地址优先级：配置了域名 → 用域名；否则配置了公网 IP → 用公网 IP；否则默认本地（localhost + 端口）。域名可用免费的 DuckDNS，也可以完全不用。
- Oracle 公网 IP 使用"保留 IP"。
- NestJS 的 ORM 用 Prisma。
- lite profile = 部署到 Oracle、给雇主展示工程能力的版本，Langfuse 等较大组件不部署。

## 3. 建议（待确认）

- 架构：Next.js(3000) / NestJS(4000) / FastAPI(8000) / MCP Server 独立进程；LiteLLM 作为 LLM 网关；Postgres + pgvector；Redis；对象存储。
- hybrid search：Postgres 内实现 BM25 风格关键词检索（全文索引）+ pgvector 向量检索 + 应用层 RRF 融合 + rerank；检索器接口可插拔，full profile 可加 Elasticsearch / OpenSearch 对比。中文以后需要分词（如 jieba）。
- embedding：OpenAI 的 embeddings 接口（与对话模型同一把 key，单独计费），例如 `text-embedding-3-small`；不自己部署。
- lite 轻量替代：Kafka → Redis Streams 或 Postgres outbox；Elasticsearch → Postgres 全文 + pgvector；Redis Cluster → 单节点；MinIO → Oracle Object Storage 或单节点 MinIO。
- 身份认证：NestJS 与 FastAPI 都用标准 OIDC/JWKS 校验 JWT。full 用 Keycloak；lite 待实测内存后决定（备选 Logto，或自签 JWT）。
- 入口：默认 `localhost` 加不同端口；Oracle 演示站先用公网 IP 加端口（无 HTTPS，仅用虚构账号）。有域名后再加子域名和 HTTPS，域名通过环境变量配置，不写死在仓库里。
- Oracle：只开 1 台 VM、单节点 k3s、两个 namespace；实际额度需用户在账号里核实（网上报道 2026 年 6 月起为 2 核 12GB）。

## 4. 样例数据（已生成）

位置：[ai-module/sample-data/](ai-module/sample-data/)。28 份英文文档（docx、pdf、md、txt）、7 张结构化 CSV、70 条评测问答。说明见该目录的 README。

## 5. 目录结构

```
StarEdu/
├── README.md                  本文件
├── docs/
│   └── project-requirements.md   需求与讨论记录（含待核实项）
├── ai-module/
│   ├── README.md
│   └── sample-data/           样例文档、CSV、评测集、生成工具
└── business-module/
    └── README.md              （占位，尚未开始）
```

## 6. 尚未讨论的事项

1. 企业后台要做开源竞品的哪些模块。
2. GitHub 仓库结构（monorepo 或多仓库）和许可证。
3. ORM（Prisma 或 TypeORM）。
4. lite profile 的身份服务。
5. 预建向量库转储的具体做法（等 ETL 管线和 embedding 模型定下来后做）。

## 7. 流程

需求确认 → 正式设计文档 → 用户批准 → 实施计划 → 开发。在用户批准之前，不生成应用代码。
