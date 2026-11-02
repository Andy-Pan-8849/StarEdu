# 设计文档 01：总体架构与代码结构（AI 模块，第一阶段）

状态：**第 7 节的 1–4 项已获用户确认（2026-11-02），第 5 项按第九轮讨论修订；本文视为已批准。** 其余设计文档批准前不写应用代码。
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
| web | 聊天页、会话列表、引用展示、文档管理页 | 文档管理页仅 `RAGETLAdmin` 可见 |
| api | 认证、会话、聊天（SSE）、文档管理接口、评测触发 | 无状态，可多副本 |
| worker | 消费入库任务，执行 ETL | 与 api 共用 `core`，独立进程 |
| mcp-server | 以 MCP 暴露工具，校验同一个 JWT | 独立进程，**【建议】** 端口 8100 |
| core | 共享库：配置、数据库、权限、检索、LLM 客户端、模型定义 | 不单独部署 |
| Postgres | 业务元数据、分块、向量、会话、审计 | 单实例，按 schema 区分 |
| 对象存储 | 原始文档 | full：MinIO 兼容（pgsty/silo，见 4.7）；lite：【待定】 |
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

### 4.3 认证与角色【已定，第九轮】

- 业务范围：**只做直营**，样例中的 8 个校区全部视为总部直营；加盟店（独立管理的多租户）不在范围内，权限结构保留 `campus_id` 属性，以后可扩展。
- Keycloak realm 角色共 7 个：
  - 业务角色：`student`、`staff`、`manager`、`hr`、`finance`，与评测集的访问模型一一对应。
  - 管理角色：`Admin`、`RAGETLAdmin`。
- **不设 `SchoolAdmin`**：校区管理者用 `manager` 角色 + `campus_id` 属性表达（样例中的 Campus Director，职级 M3）。
- 属性（JWT 声明）：用户 ID、角色、`campus_id`、`level`（来自 `employees.csv`）；部门等其余字段预留。
- `Admin`：管理用户、分配角色、系统配置。**默认不读受限文档内容**（最小权限）；需要读内容时必须同时拥有相应业务角色。
- `RAGETLAdmin`：上传、删除、重新入库文档，查看入库状态；读取文档内容仍按其业务角色。
- api 与 MCP Server 各自校验 JWT，不信任前端传来的任何身份字段。
- 测试账号：每个角色至少一个，另加针对校区的账号（北京 staff、上海 staff、上海 manager），用于测"同角色不同校区"。第二阶段可加 `Auditor`（只读审计日志）。

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
| Postgres | 5432 |
| Redis | 6379 |
| MinIO | 9000 / 9001 |

**使用各组件的常用默认端口，方便学习者**；主机端口同时做成环境变量，本机端口被占用时只改 `.env`，容器之间用服务名通信，不受影响。

### 4.7 对象存储【M0 修订，2026-11-02】

- 核实结果：官方 MinIO 的 Docker 镜像（`minio/minio`、`quay.io/minio/minio`）已无法从官方仓库拉取。
- 决定：full profile 的 S3 兼容存储使用 MinIO 的社区分支 **`pgsty/silo`**（固定版本标签，amd64 / arm64 均有，RAGFlow 试用时已在本机运行）；端口和环境变量与 MinIO 相同（9000 / 9001）。
- **代码只依赖 S3 API**，所以以后换成别的 S3 兼容实现（如 SeaweedFS、云厂商的对象存储）只改配置。lite profile 的对象存储仍为【待定】。

### 4.8 身份实现（M1 实际做法，2026-11-02）

- Keycloak `26.8.1`，`start-dev` + 内置文件数据库（容器卷），realm 文件 `deploy/compose/keycloak/starit-realm.json` 在首次启动时导入。仅用于本地 full profile；lite 的身份方案仍为【待定】。
- 令牌的签发者固定为 `http://localhost:8080/realms/starit`（`KC_HOSTNAME`）。后端用两个配置：`STARIT_OIDC_ISSUER`（校验签发者）和 `STARIT_OIDC_JWKS_URL`（拉取公钥，容器内走 Compose 网络）。
- 令牌携带 `realm_access.roles`、`campus_id`、`level`，受众同时包含 `starit-api` 和 `starit-mcp`。`campus_id`、`level` 在 realm 的用户属性（declarative user profile）里**显式声明**，没有开启"非托管属性"。
- 后端只接受 RS256 / ES256，检查签名、过期时间、签发者、受众，要求 `sub`；拒绝 `alg: none` 和 HS256（防算法混淆）；只认 7 个已知角色，其余（Keycloak 默认角色）忽略。
- 取不到公钥（身份服务不可用）返回 503，不当作 401。
- 统一错误格式（03 第 1 节）已落实：401 / 403 / 404 / 422 都带 `request_id`。
- `starit-web` 客户端开启了密码模式，只为本地脚本和测试取令牌；真实部署必须关闭。

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

## 7. 确认结果（2026-11-02）

1. 入库队列用 Postgres 表：**接受**。
2. lite 进程内 litellm、full 用代理：**接受**。
3. 目录结构（含 `web/` 放在 `ai-module/` 下）：**接受**。
4. 端口规划：**接受**。
5. 角色：按第九轮讨论修订，见 4.3。
