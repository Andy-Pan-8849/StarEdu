# 样板工程需求文档：传统业务 + AI 能力融合（Enterprise Knowledge Assistant + Agent）

- 状态：**草稿 v0.2，需求澄清中，尚未批准，尚未生成任何代码**
- 日期：2026-10-19
- 标记约定：【用户决定】= 用户明确说过；【我的建议】= Claude 的推测或建议，待用户确认；【待核实】= 事实未经官方来源确认

---

## 1. 项目目的

1. 展示用户自己的工程能力（作品集）。
2. 作为中小企业 AI 应用开发的蓝本，开源到 GitHub，供他人学习和继续开发。

## 2. 总体构成（三个子项目，分先后）

| 顺序 | 子项目 | 说明 |
|---|---|---|
| 1 | AI 工程项目 | RAG ETL 引擎 + RAG + Agent（FastAPI、MCP Server、PostgreSQL + pgvector、Next.js 前端） |
| 2 | 企业后台管理项目 | 按开源竞品的需求，用 TypeScript 重做：Next.js 15 + Tailwind + shadcn/ui + NestJS |
| 3 | 全套可观测性 | Prometheus、Grafana、Loki、Tempo、OpenTelemetry；Langfuse 仅本地 |

【用户决定】先做 AI 项目，再做企业后台。两个系统用不同入口 URL 演示。
【我的建议】namespace、Ingress、数据库划分从第一天就按两个系统设计，避免返工。

## 3. 参考架构图

- 文件：`Documents/my_document/others/TempFiles/interview_arch_traditional_plus_ai_v2.png`（NestJS 版，用户指定的基准图）
- 另有 `interview_arch_springboot_plus_ai.png`（Spring Boot 对比版，本项目不采用）
- 图中分层：浏览器 → 边缘/反向代理 + Keycloak → Next.js(3000) / NestJS(4000) / FastAPI(8000) → Agent 层 → MCP Server → LLM Gateway → 数据层 → 可观测性与部署

## 4. 双 Profile 策略

【用户决定】采用 full profile + lite profile，同一份代码，用 Helm values / Compose profile 区分。

- **full profile**：本地运行（用户本地至少 100GB 磁盘），尽量完整实现架构图。
- **lite profile**：部署到 Oracle Always Free，用于在线演示，轻量替代。

### 4.1 已确定的取舍

| 项 | 决定 |
|---|---|
| ArgoCD、Vault、Sentry | 【用户决定】先不做，以后工作需要再搞 |
| 本地 vLLM | 【用户决定】不部署，直接连 OpenAI 和 Anthropic（用户已购买两家 API） |
| Langfuse v3 | 【用户决定】只在本地用，不部署到 Oracle |
| RAG ETL 引擎 | 【用户决定】希望有；如果太大，只部署本地，不上 Oracle（见第 6 节） |
| Keycloak | 【用户决定】Java 版可以接受，能联合工作即可（见第 7 节） |
| 部署方式 | 【用户决定】本地 Docker Compose 开发；服务器装 k3s |
| 移动端 App | 【我的建议】不做 |
| 前端框架 | 【我的建议】统一 Next.js 15 + Tailwind + shadcn/ui（图中的 React SPA 不单独做）——待确认 |

### 4.2 lite profile 的轻量替代（【我的建议】，待确认）

| 架构图组件 | lite（Oracle） | full（本地） |
|---|---|---|
| Kafka | Redis Streams 或 Postgres outbox 表 | Kafka |
| Elasticsearch | Postgres 全文检索 + pgvector 混合检索 | Elasticsearch |
| Redis Cluster | 单节点 Redis | Redis（可选 Sentinel） |
| MinIO | Oracle Object Storage（S3 兼容，免费额度【待核实】）或 MinIO 单节点 | MinIO |
| Langfuse | 不部署 | 部署（v3 自带 ClickHouse，较重） |
| 可观测性 | Prometheus、Grafana、Loki、Tempo、OTel 保留（可能裁剪保留期） | 全套 |
| LLM Gateway | LiteLLM，转发 OpenAI / Anthropic | 同左 |
| Keycloak | 待定（见 7） | Keycloak |
| RAG ETL 引擎 | 轻量解析 + 预置样例语料（见 6） | 完整引擎 |

## 5. 部署目标：Oracle Always Free

- 用户引用的规格：Arm Ampere A1，1,500 OCPU 小时、9,000 GB 小时每月，12GB 内存，可作为 1 台或 2 台 VM。
- 【待核实】网上报道称 2026 年 6 月 Oracle 将 A1 额度从 4 核 24GB 降到 2 核 12GB，且未公告；另有未证实说法，升级为 Pay As You Go 后可能仍享 4 核 24GB。Oracle 官方页面对自动抓取返回 403，未能核对。**用户需在自己账号里确认实际额度。**
- 闲置回收：7 天内 CPU、网络、（A1）内存的 P95 都低于 20% 的实例可能被回收。
- 【我的建议】只开 1 台 VM（2 OCPU / 12GB），单节点 k3s，Traefik（k3s 自带）按域名分流，cert-manager 申请证书，两个系统两个 namespace，需要自有域名。
- 所有镜像必须有 arm64 版本。
- 单点故障风险：需要重建脚本和备份。
- 备选（不免费）：Hetzner ARM 机型，价格【待核实】。免费替代里没有比 Oracle 内存更大的永久免费方案（GCP e2-micro 仅 1GB）。

### 5.1 lite profile 内存预算（粗估，【我的建议】，需实测）

| 组件 | 约 GB |
|---|---|
| k3s | 0.5 – 1 |
| PostgreSQL + pgvector | 1 – 2 |
| FastAPI + MCP + 两个 Next.js + NestJS | 2 – 3 |
| Redis | 0.2 |
| 可观测性（Prometheus、Grafana、Loki、Tempo、OTel） | 约 2 |
| IdP（如用 Keycloak，含自身占用） | 约 1 – 1.5 |
| 合计 | 约 7 – 10，余量很小 |

结论：12GB 能放下 lite，但没有富余；Keycloak 与 RAG ETL 引擎是最大的不确定项。

## 6. RAG ETL 引擎（待决策）

用途：输入 PDF、Word、TXT 等文档，展示 RAG 能力（解析 → 分块 → 向量化 → 入库）。

候选（来源为聚合/评测类网页，缺少硬性资源数据，**选型前需在用户的真实文档上实测**）：

| 候选 | 定位 | 资源 | 备注 |
|---|---|---|---|
| RAGFlow | 完整 RAG 引擎（含深度文档理解、知识库、UI） | 最重，参考建议 4 核以上、16GB 内存 | Apache 2.0；自带一整套服务，与本项目自己的 RAG + Agent 有功能重叠 |
| Docling（IBM） | 文档转换工具包：PDF、DOCX、PPTX、HTML、图片 → Markdown/JSON | 相对较轻（无硬数据） | Apache 2.0；适合作为管线里的解析器 |
| Unstructured | 解析 + 多格式、多连接器 | 取决于启用的依赖，开源版依赖较重 | 格式覆盖广 |

【我的建议】（待确认）：
1. **自己写 ETL 管线**（FastAPI + 后台 worker：解析 → 清洗 → 分块 → embedding → 写 pgvector），解析器做成可插拔。展示的是工程能力，而不是装一个现成产品。
2. full profile 用 **Docling** 做解析（质量高，支持版面和表格）。
3. lite profile 用轻量解析器（如 pymupdf、python-docx、纯文本），并在 Oracle 上**预置样例文档和已建好的向量库**，现场上传小文件也可用。
4. RAGFlow 不集成，只在文档里作为"对标产品"提及；如用户想看，可在本地单独跑。

## 7. 身份认证（Keycloak 问题）

- Keycloak 是 Java（Quarkus）实现，没有 TypeScript 版本。
- 资源：有 2026 年评测称单节点加 PostgreSQL 空闲约 1.5GB，启动 60–90 秒；Authentik 约 0.6–0.8GB。
- TypeScript 实现的替代：Logto（TypeScript，MPL 2.0，OIDC / OAuth 2.0），无可靠的内存数据，需实测。Zitadel 为 Go。
- 【我的建议】（待确认）：
  1. 架构上只依赖标准 OIDC / JWKS：NestJS 与 FastAPI 都通过 JWKS 校验同一个 JWT，IdP 可替换。
  2. full profile 用 Keycloak（行业标准，有简历价值）。
  3. lite profile 是否也用 Keycloak，待实测内存后再定；备选 Logto，或由 NestJS 自己签发 JWT（同样走 JWKS）。

## 8. 技术栈汇总

- 前端：Next.js 15、Tailwind、shadcn/ui
- 传统业务后端：NestJS（TypeScript），ORM 按图为 Prisma 或 TypeORM（【待定】）
- AI 后端：FastAPI、LangGraph（图中）、MCP Server、LiteLLM
- 数据：PostgreSQL + pgvector、Redis、对象存储
- 部署：Docker Compose（开发）、k3s + Helm（服务器）
- 可观测性：Prometheus、Grafana、Loki、Tempo、OpenTelemetry；Langfuse（仅本地）

## 9. 未决问题清单

1. lite / full 的取舍表（4.2）是否全部接受？
2. RAG ETL 方案（第 6 节建议）是否接受？
3. lite profile 的 IdP 用什么（第 7 节）？
4. Oracle 账号实际额度（用户核实）。
5. 是否已有域名？
6. 企业后台的功能范围（开源竞品的哪些模块：用户、角色、菜单、部门、字典、日志、定时任务等）——尚未讨论。
7. AI 项目的演示场景与样例数据（用什么文档、什么业务问题）——尚未讨论。
8. GitHub 仓库结构（monorepo 还是多仓库）、许可证——尚未讨论。
9. ORM 选择、前端是否还需要别的 UI 约束——尚未讨论。

## 10. 流程约定

- 所有需求确认完之前，不生成代码，不下载或安装任何资源。
- 需求确认后：写正式设计文档 → 用户批准 → 写实施计划 → 再动手。
- 本文档随讨论更新，保留作为后续校对依据。

---

## 11. 更新记录

### 2026-10-19 第二轮

【用户决定】
- 成本策略：能买就不自己做；暂时没有域名，能省则省。
- AI 项目重点放在 **Agent 开发**；RAG 部分重点做 **hybrid search**，掌握其原理。
- 先在本地部署 **RAGFlow** 作为学习和对标；项目本身采用"FastAPI + 后台 worker 自建 ETL 管线，解析器可插拔"，以减小体积。
- 希望准备"预置样例文档和向量库"：以全国多校区的 IT 培训企业为背景，合成 HR（招聘、培训、选拔、晋升）、Finance（费用报销、工资发放、福利）、Technical Support（Java/Python/TS 环境配置、课件下载、作业提交、学员项目协作规定）三个领域的示例数据。**用户决定开工前，先说明方案（见下）。**

【我的建议】（待确认）
- 域名：非必须。可用公网 IP + 不同端口，或免费子域名（DuckDNS / sslip.io），也可买约 10 美元/年的域名。
- 检索：Elasticsearch 本身有 BM25 + dense_vector + 混合排序，但本项目 lite 用 Postgres（pgvector + 全文检索 + 应用层 RRF）手写 hybrid search 以学习原理；检索器做成可插拔，full profile 可加 Elasticsearch / OpenSearch 对比。中文需要分词（jieba 等）。
- 样例公司用**虚构**企业，不使用达内、黑马、青鸟等真实公司名称和材料。
- 样例包含：源文档（多格式）、评测问答集、业务结构化数据（同时可为企业后台和 SQL Agent 提供种子数据）、预建向量库转储与可重建脚本。

### 2026-10-19 第三轮

【用户决定】
- 不使用域名时，用不同端口区分入口也可以；开源项目不能因域名失效而跑不起来。
- 样例数据先做**英文版**，中文版以后再做。
- 虚构公司名：**星辰 IT 教育 / StarIT Education**。
- 建立项目目录 `starit-enterprise-ai-blueprint/`，下分 `ai-module/`（AI 模块资料）与 `business-module/`（传统业务模块资料）；根目录建立 README.md 记录功能与架构决定。
- 现在就生成样例数据，放在 AI 模块目录下备用。

【已完成】
- 样例数据位于 `ai-module/sample-data/`：28 份英文文档（docx、pdf、md、txt 混合）、7 张结构化 CSV、54 条文档问答 + 16 条 SQL 问答，以及可重复生成的脚本。
- 向量库**尚未生成**：等 ETL 管线和 embedding 模型确定后，由管线生成。

【我的建议】
- 默认配置：localhost 加端口；Oracle 演示站先用公网 IP 加端口；域名和 HTTPS 作为可选项，域名由环境变量配置。
- embedding 使用 OpenAI embeddings 接口（单独计费，非自部署）；模型选择待确认。

### 2026-10-19 第四轮

【用户决定】
- embedding 模型用 `text-embedding-3-small`；模型和提供方做成可配置变量，以后换自部署或其他模型只改变量。
- Oracle 公网 IP 设为"保留 IP"（用户自己在 Oracle 控制台操作）。
- 先用 DuckDNS 作为可选的免费域名；入口地址的优先级：配置了域名用域名，否则配置了公网 IP 用公网 IP，否则默认本地（localhost + 端口）。README 的安装部署部分要写清这三种方式，学习者可以只用本地。
- 企业后台要做开源竞品的哪些模块：以后再和用户讨论，先做 AI 部分。
- NestJS 的 ORM 用 **Prisma**。
- lite profile 的定义：部署到 Oracle，给雇主访问展示工程能力；Langfuse 等较大组件不部署。

【我的建议】（待确认）
- 配置方式：Docker Compose 用 `.env`（提供 `.env.example`，真实 `.env` 不进 Git），k3s 用 Helm values + Secret，两边变量名保持一致。密钥（API key）只放 `.env` 或 Secret。
- embedding 变量：`EMBEDDING_PROVIDER`、`EMBEDDING_MODEL`、`EMBEDDING_DIMENSIONS`。换模型意味着向量维度可能变化，已入库的数据必须重新生成向量；入库时在每个分块上记录所用模型名和维度。
- Prisma 只管 NestJS 的表；FastAPI 侧另用自己的迁移工具；两边用同一个 Postgres 实例的不同 schema，避免互相覆盖。
- GitHub：单仓库（monorepo），尽早建仓库，先 private，检查完再公开；许可证建议 MIT（或 Apache-2.0）。
- DuckDNS 的有效期、是否会因长期不活跃被回收，我没有查到官方说明，需用户查看 duckdns.org 的说明，不要在文档里承诺"一年"。

【待办】
- lite profile 的登录系统（Keycloak 在 Oracle 上占约 1.5GB 内存）是否部署，等 AI 部分做完、实测内存后再定。
- 用户检查样例数据后反馈。

### 2026-10-31 第五轮（RAGFlow 试用后的设计要求）

【用户决定】
- Agent 流程必须有**显式的 End 状态**。起因：RAGFlow 的 Agent 画布只有开始组件，没有结束组件，看图无法判断流程在哪里结束，也看不出是正常结束还是漏连线。

【我的建议】（待确认细节）
- 自建 Agent（LangGraph）的每条路径都以一个命名的 End 节点收尾，不允许"没有下游就算结束"。
- 每个 End 带**原因码**，例如 `answered`、`need_role`、`no_permission`、`not_found`、`error`。
- 一次运行结束时，把 End 名称和原因码写入 trace（Langfuse）和业务日志，用于调试和统计"多少问题没答上来"。
- 流程图的可视化（文档或前端）也要画出 End 节点。
- 同时记录一条相关教训：多轮对话里"等待用户补充"和"新问题"要用明确的会话状态区分（如 `clarifying` / `answering`），不依赖 `sys.query` 之类的隐式变量；身份和权限来自登录信息，不由 LLM 判断。

### 2026-10-31 第六轮（权限设计，待确认）

【背景】用户询问企业文档权限在 RAG 助手里的业界做法。RAGFlow 的权限在数据集一级，没有按文档、按用户的过滤，因此只用于学习对标，不作为 StarEdu 的权限方案。以下是我基于已有知识给出的方案，未联网核对。

【我的建议】（待确认）
1. **模型组合**：RBAC 定大范围（角色 / 部门），ABAC 用属性缩小（职级、校区、密级），个别敏感文件用 ACL 点名到人。不使用单一 RBAC。
2. **文档元数据**：入库时为每份文档写 `department`、`sensitivity`（public / internal / confidential / restricted）、`allowed_roles`、可选 `allowed_users`、`min_level`、`campus`、`status` / `version`。分块继承所属文档的全部权限字段。
3. **身份来源**：Keycloak 签发的 JWT 声明（角色、部门、职级）。身份不由用户在聊天中自述，也不由 LLM 判断。
4. **强制执行位置**：检索层在数据库查询中过滤（pgvector 的元数据条件 + 全文检索条件，可选 Postgres 行级安全 RLS 作双保险），**先过滤再排序和融合**；只有通过过滤的分块才进入提示词；无结果时回答"没有权限或未找到"，不让模型编。
5. **派生内容继承权限**：入库时生成的摘要、问题、关键词，继承原文档权限。
6. **缓存与记忆**：回答缓存的键带权限维度；对话 Memory 只保存稳定的用户偏好，不保存来自受限文档的内容。
7. **拒绝话术**：不在拒绝中透露受限内容。
8. **审计**：记录用户、时间、查询、命中的文档 ID，写入日志和 trace。
9. **权限变更**：员工转岗、离职需要及时生效；样例中以事件或定期同步实现，具体方式待定。
10. **测试**：使用评测集中的 `access` 类问题（如 DOC-45 / DOC-46：同一薪资问题，HR 应答，学生应拒绝）作为权限回归测试，并补充"统计类问题"和"跨用户缓存"两类用例。

【待确认】
- 职级、校区是否纳入样例的权限属性（样例数据目前只有角色层面的划分）。
- 是否启用 Postgres RLS。
- 个别文件"按人指定"是否要在样例中演示。
