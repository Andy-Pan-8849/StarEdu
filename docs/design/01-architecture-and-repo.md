# 设计文档 01：总体架构与代码结构（AI 模块，第一阶段）

状态：**草稿，待用户批准。** 批准前不写应用代码。
范围：AI 模块第一阶段（功能清单见 `docs/project-requirements.md` 第七轮）。传统业务模块不在本文范围。

标记约定：**【已定】** 用户已决定；**【建议】** 我的建议，待批准；**【待定】** 需要实测或另议。

## 1. 已确定的技术选型

| 项 | 选择 | 状态 |
|---|---|---|
| Python | 3.12，包管理用 uv（工作区 workspace） | 【已定】 |
| AI 后端 | FastAPI | 【已定】 |
| Agent 编排 | LangGraph | 【已定】 |
| 工具协议 | MCP Server（独立进程） | 【已定】 |
| 数据库 | PostgreSQL + pgvector；全文检索用 Postgres 自带 | 【已定】 |
| 前端 | Next.js 15、Tailwind、shadcn/ui | 【已定】 |
| 身份 | Keycloak（full），标准 OIDC / JWKS 校验 JWT | 【已定】 |
| LLM | OpenAI、Anthropic，经 LiteLLM | 【已定】 |
| Embedding | `text-embedding-3-small`，提供方、模型、维度为配置变量 | 【已定】 |
| 追踪 | Langfuse（仅本地）、OpenTelemetry | 【已定】 |

## 2. 组件与职责

```
浏览器 ── Next.js(web) ──HTTP/SSE──▶ FastAPI(api) ──▶ LangGraph 流程
                                          │                │
                                          │                ├─▶ 检索服务(core)：权限过滤 → 全文 + 向量 → RRF → Rerank
                                          │                ├─▶ MCP Server：文档检索、课程/学员只读、报销状态
                                          │                └─▶ LLM 客户端 ─▶ LiteLLM ─▶ OpenAI / Anthropic
                                          ▼
                                    PostgreSQL + pgvector
                                          ▲
上传 ─▶ api ─▶ 对象存储 + ingestion_jobs ─▶ worker（解析→分块→派生→向量化→写入）

JWT 由 Keycloak 签发；api、MCP Server 都用 JWKS 校验。
每次运行的 trace 发往 Langfuse / OTel。
```

| 组件 | 职责 | 备注 |
|---|---|---|
| web | 聊天页、会话列表、引用展示、文档管理页 | 文档管理页仅 `RAGETLAdmin` / `Admin` 可见 |
| api | 认证、会话、聊天（SSE）、文档管理接口、评测触发 | 无状态，可多副本 |
| worker | 消费入库任务，执行 ETL | 与 api 共用 `core`，独立进程 |
| mcp-server | 以 MCP 暴露工具，校验同一个 JWT | 独立进程，**【建议】** 端口 8100 |
| core | 共享库：配置、数据库、权限、检索、LLM 客户端、模型定义 | 不单独部署 |
| Postgres | 业务元数据、分块、向量、会话、审计 | 单实例，按 schema 区分 |
| 对象存储 | 原始文档 | full：MinIO；lite：【待定】 |
| Redis | 缓存、限流 | **不承载任务队列**，见 4.1 |

## 3. 代码结构【建议】

沿用现有 `ai-module/`，Python 部分用 uv workspace：

```
ai-module/
├── pyproject.toml            uv workspace 根
├── .python-version           3.12
├── packages/
│   └── core/                 共享库（src/starit_core）
├── apps/
│   ├── api/                  FastAPI
│   ├── worker/               ETL worker
│   └── mcp-server/           MCP Server
├── web/                      Next.js
├── migrations/               Alembic（AI 侧自己的 schema）
├── eval/                     评测运行器与报告（评测数据仍在 sample-data/eval）
├── deploy/
│   ├── compose/              full / lite 的 compose 文件、.env.example
│   └── k3s/                  Helm values（后续）
└── sample-data/              已有
```

要点：
- 业务模块以后在 `business-module/` 自成一体，不与 AI 模块共享代码；两边只通过 HTTP / JWT 和同一 Postgres 实例的不同 schema 交互。
- `core` 不依赖 FastAPI，保证 worker、MCP Server、评测运行器都能直接复用。
- 每个 app 有自己的 Dockerfile，共享同一份 lock 文件。

## 4. 关键设计决定

### 4.1 入库任务队列：Postgres 表 +`FOR UPDATE SKIP LOCKED`【建议】

- 理由：full 和 lite 都不需要新增组件，任务和文档状态在同一事务里更新，失败重试和可见性（"入库状态、失败原因"）直接查表。
- 代价：吞吐低于 Kafka / Redis Streams，但样例规模（几十到几百个文档）足够。
- 接口隔离：worker 只依赖 `JobQueue` 接口，以后换成 Redis Streams 不影响业务代码。

### 4.2 LLM 访问：统一接口，两种实现【建议】

- 代码只依赖 `core` 里的 `LLMClient` 接口（聊天、流式、embedding）。
- full：经 LiteLLM 代理服务；lite：为省内存，进程内直接用 litellm 库。两者的配置变量名保持一致。

### 4.3 认证与角色【建议】

- Keycloak realm 角色：`student`、`staff`、`manager`、`hr`、`finance`，加管理角色 `Admin`、`RAGETLAdmin`。
- JWT 声明携带：用户 ID、角色、部门、职级、校区（样例先用角色层面，其余字段预留，见需求文档第六轮"待确认"）。
- `Admin`：用户与角色管理，拥有全部权限。`RAGETLAdmin`：文档的上传、删除、重新入库、查看入库状态。
- api 与 MCP Server 各自校验 JWT，不信任前端传来的任何身份字段。

### 4.4 流程控制：LangGraph 状态图【建议】

- 外层是固定图，检索是固定节点；LLM 只负责意图理解、查询改写和生成。
- 每次运行以显式 End 节点结束，带原因码。具体节点和原因码在设计文档 04 中列出。
- 会话状态（`answering` / `need_clarification`）是图状态的显式字段，不依赖隐式变量。

### 4.5 配置【建议】

- 环境变量为唯一来源；Compose 用 `.env`（提供 `.env.example`，真实 `.env` 不进 Git）。
- 变量名前缀 `STARIT_`，按组件分组；embedding 相关：`EMBEDDING_PROVIDER`、`EMBEDDING_MODEL`、`EMBEDDING_DIMENSIONS`。
- 入口地址优先级沿用已定规则：域名 → 公网 IP → localhost + 端口。

### 4.6 端口规划【建议】

| 服务 | 端口 |
|---|---|
| web（AI） | 3000 |
| 业务 web / NestJS（以后） | 3001 / 4000 |
| api | 8000 |
| mcp-server | 8100 |
| Keycloak | 8080 |
| LiteLLM | 4100（避开 NestJS 的 4000） |
| Langfuse web | 3100（避开 3000） |
| Postgres / Redis | 5432 / 6379 |
| MinIO | 9000 / 9001 |

## 5. 两个 Profile 的差异（AI 模块）

| 项 | full（本地 Compose） | lite（Oracle k3s） |
|---|---|---|
| 身份服务 | Keycloak | 【待定】（实测内存后定） |
| LLM 访问 | LiteLLM 代理 | 进程内 litellm |
| 追踪 | Langfuse + OTel | 仅 OTel，Langfuse 不部署 |
| 可观测性 | Prometheus、Grafana、Loki、Tempo | 缩减，具体见后续文档 |
| 对象存储 | MinIO | 【待定】 |
| Rerank | 同一实现，按配置选模型 | 同左，优先选小模型或调用 API |

## 6. 待下一份文档回答的问题

- 02 数据模型：表结构、权限元数据字段、索引（全文 + 向量）、会话与审计表。
- 03 API 与 MCP 契约。
- 04 Agent 流程图、End 状态与原因码。
- 05 检索与权限：过滤、RRF、Rerank、评测方案。
- 06 两个 profile 的部署细节与内存预算（需要实测）。

## 7. 需要你确认的点

1. 4.1 用 Postgres 表做入库队列，是否接受？
2. 4.2 lite 进程内用 litellm 库、full 用代理，是否接受？
3. 3 节的目录结构（尤其 `web/` 放在 `ai-module/` 下）是否接受？
4. 4.6 端口规划是否有冲突或偏好？
5. 角色名 `RAGETLAdmin` 按你给的原样使用；`Admin` 同时拥有全部权限，这个理解对吗？
