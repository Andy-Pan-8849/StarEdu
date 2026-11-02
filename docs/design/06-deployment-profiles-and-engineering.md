# 设计文档 06：部署 Profile、可观测性与工程规范（AI 模块，第一阶段）

状态：**草稿，待用户批准。** 批准前不写应用代码。
依赖：01–05。标记约定：**【已定】**、**【建议】**、**【待定】**（需要实测）。
**注意**：本文的内存数字都是粗估，没有实测，不能当作承诺；实测后回填。

## 1. 两个 Profile 的服务清单

| 服务 | full（本地 Compose） | lite（Oracle k3s） | 备注 |
|---|---|---|---|
| web（Next.js） | ✅ | ✅ | |
| api（FastAPI） | ✅ | ✅ | |
| worker | ✅ | ✅ | |
| mcp-server | ✅ | ✅ | |
| Postgres + pgvector | ✅ | ✅ | 现成的 pgvector 镜像；BM25 扩展暂不引入（见 05） |
| Redis | ✅ | ✅（单节点） | 限流和缓存 |
| 对象存储 | MinIO | 【待定】单节点 MinIO 或 Oracle 对象存储 | |
| Keycloak | ✅ | 【待定】 | 见 3 |
| LiteLLM 代理 | ✅ | ❌（进程内 litellm 库） | 见 01 的 4.2 |
| Langfuse | ✅ | ❌ | 依赖较多，仅本地 |
| OTel Collector | ✅ | ✅ | |
| Prometheus、Grafana | ✅ | ✅（精简） | |
| Loki、Tempo | ✅ | 【待定】视内存 | |

## 2. 本地 full profile

### 2.1 启动【建议】

- 一个 `deploy/compose/` 目录：`compose.yaml`（核心服务）加可选的 override 文件（`observability.yaml`、`langfuse.yaml`），用 profile 或多文件组合，**学习者可以只启动核心服务**。
- 提供 `make up`、`make down`、`make seed` 等封装；每个服务有健康检查，依赖顺序用 `depends_on: condition: service_healthy`。
- `.env.example` 列出所有变量并带说明；真实 `.env` 不进 Git。**必须由用户提供的只有 LLM 的 API 密钥**（OpenAI；用 Anthropic 时再加）。

### 2.2 资源（粗估，待实测）

你的机器是 16 GB 的 Mac。把 Docker Desktop 的内存上限设为约 8–10 GB 比较稳妥。粗略估计各部分占用：

| 部分 | 粗估 |
|---|---|
| Postgres | 0.3–0.5 GB |
| api + worker + mcp-server | 约 0.2–0.4 GB 各一个 |
| web | 约 0.3 GB |
| Keycloak | 约 1–1.5 GB（需求文档里查到的数值） |
| Redis、MinIO | 各约 0.1–0.2 GB |
| Prometheus、Grafana、Loki、Tempo、OTel | 合计约 1–1.5 GB |
| Langfuse（含其依赖的存储） | 可能 2 GB 以上，**未核实** |

核心服务能跑在 4 GB 以内，完整的可观测性和 Langfuse 另加。**学习者可以分层启动**，这是 2.1 要把可选组件拆开的原因。

## 3. lite profile（Oracle k3s）

- **只开 1 台 VM、单节点 k3s、两个 namespace**【已定】；Oracle 的实际额度由你核实（需求文档里记的"2 核 12 GB"是网上报道，未核实）。
- 部署用 Helm chart，变量名与 `.env` 保持一致（Secret 存密钥）。
- **身份服务**【待定】：判断规则是"先实测 Keycloak 在该机器上的内存占用"。备选：Logto，或由 api 自己签发 JWT 并公开 JWKS（接口不变，api 和 MCP 仍然只校验 JWKS）。**第一阶段先完成 full，lite 的身份方案在实施计划里单独排期。**
- 对外：公网 IP + 端口，演示用虚构账号，**不放任何真实数据**；LLM 调用设置**每日费用上限**，避免被滥用。
- lite 先上线最小集：web、api、worker、mcp-server、Postgres、Redis，加身份服务；可观测性视内存逐步加。

## 4. 配置与密钥【建议】

- 环境变量是唯一来源；变量名前缀 `STARIT_`，按组件分组。示例：

| 分组 | 变量（节选） |
|---|---|
| LLM | `STARIT_LLM_GATEWAY`（`litellm_proxy` / `litellm_lib`）、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、各节点模型名 `STARIT_MODEL_UNDERSTAND`、`STARIT_MODEL_GENERATE`、`STARIT_MODEL_RERANK` |
| Embedding | `EMBEDDING_PROVIDER`、`EMBEDDING_MODEL`、`EMBEDDING_DIMENSIONS` |
| 检索 | `STARIT_RETRIEVAL_MODE`、`STARIT_KEYWORD_SEARCHER`、各数值参数（见 05 的 2.1） |
| 身份 | `STARIT_OIDC_ISSUER`、`STARIT_OIDC_AUDIENCE_API`、`STARIT_OIDC_AUDIENCE_MCP` |
| 限额 | `STARIT_RATE_LIMIT_CHAT`、`STARIT_DAILY_LLM_BUDGET` |

- 密钥只放 `.env` 或 Secret，**不写进镜像、不进日志、不进 trace**；日志里对密钥和 JWT 做脱敏。

## 5. 样例数据与种子【建议】

1. `make seed` 做三件事：创建 Keycloak 的 realm、角色和测试账号；把 `sample-data/structured/*.csv` 导入 `biz` schema 并创建白名单视图和 `ai_sql_ro` 账号；用 05 的入库接口导入 28 份文档。
2. **预置向量库转储**（需求文档中遗留的待办）：把入库完成后的 `ai` schema 数据（分块、向量、派生内容）导出成压缩的 SQL 转储，放进仓库的 `seed/` 或发布附件。学习者可以**不用 OpenAI 密钥就先看到检索效果**，用自己的密钥时再重新入库。转储里记录 embedding 模型和维度（02 的约定），启动时发现不一致就提示重新入库。
3. 转储文件的大小需要评估（28 份文档，量级不大），超过 GitHub 限制则用发布附件。

## 6. 可观测性【建议】

- 所有服务统一接入 OpenTelemetry：HTTP 请求、数据库、LLM 调用、图的每个节点都是 span；日志带 `request_id`、`run_id`、`trace_id`。
- 指标（Prometheus）：请求量和延迟、`end_state` 分布、检索延迟、LLM 调用数和 token、入库队列长度和失败数、被权限过滤的分块比例。
- Grafana 预置仪表盘：运行概览、End 状态分布、检索与 LLM 延迟、入库任务。
- Langfuse（仅 full）：每次运行的 trace、提示词版本、评测 score。
- 审计日志在数据库里（02 的 3.4），不依赖可观测性组件。

## 7. 工程规范【建议】

| 项 | 选择 |
|---|---|
| Python | uv、Python 3.12；格式化和静态检查用 Ruff；类型检查用 mypy 或 pyright（实施时选一个）；测试用 pytest |
| 前端 | TypeScript 严格模式、ESLint、Prettier |
| 提交钩子 | pre-commit：格式、静态检查、密钥扫描（防止把 `.env` 和密钥提交上去） |
| CI（GitHub Actions） | 每次提交：Python 和前端的检查、单元和图结构测试（假 LLM）、迁移能在空库上运行；**不跑真实 LLM 的评测** |
| 数据库迁移 | Alembic；每个迁移可在空库和已有库上运行；CI 验证 |
| 依赖 | uv 的锁文件进 Git；固定 Docker 镜像的版本标签 |
| 分支与提交 | 主分支保护；小步提交，提交信息说明为什么；每个阶段完成打 tag |
| 许可证 | MIT，依赖的许可证要兼容（见 05 对 PDF 库的说明） |

## 8. 第一阶段的验收标准【建议】

1. `make up && make seed` 在一台干净的 Mac 上跑通，只需要填写 LLM 密钥。
2. 各角色账号登录后，在聊天页提问，得到带引用的回答或明确的拒绝，且每次运行都有 End 状态。
3. `RAGETLAdmin` 能在文档管理页上传、改权限、删除、重新入库，并看到入库状态和失败原因。
4. **权限回归全部通过**（05 的 4.3），`Admin` 账号读不到受限文档内容。
5. 评测命令能运行并产出报告，包含检索模式对比。
6. Langfuse 和 Grafana 能看到同一次运行的 trace 和指标。
7. 单元和图结构测试在 CI 中通过。

## 9. 需要你确认的点

1. 2.1 的分层启动（核心服务 / 可观测性 / Langfuse 可分开启动），是否接受？
2. 3：第一阶段先完成 full，lite 的身份方案和部署在实施计划里单独排期，是否接受？
3. 5 节的"预置向量库转储"：学习者无需 OpenAI 密钥即可先看到检索效果，是否接受？
4. 6 节的可观测性范围，是否接受？
5. 7 节的工程规范（Ruff、pre-commit、CI 不跑真实评测等），是否接受？
6. 8 节的验收标准，是否有要增删的？
