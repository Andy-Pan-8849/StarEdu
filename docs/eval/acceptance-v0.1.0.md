# 第一阶段验收（AI 模块 v0.1.0，2026-11-04）

对照 [设计 06 第 8 节](../design/06-deployment-profiles-and-engineering.md) 的 7 条标准逐条记录：做了什么、结果、**没有验证到的**。验收在作者自己的 Mac 上做（16 GB，Docker Desktop 内存上限约 11.7 GiB、磁盘 80 GB），**不是一台干净的机器**；真实模型是 `gpt-6-luna`（对话）和 `text-embedding-3-small`（向量）。

## 1. `make up && make seed` 从零跑通

- **做法**：`make clean`（删除本项目的全部本地数据卷：Postgres、Redis、Keycloak、对象存储、Tempo、Prometheus、Grafana、Langfuse 的全部数据；`.env` 保留），再 `make up-langfuse`（核心服务 + 可观测性 + Langfuse），再 `make seed`。
- **结果**：清理 19 秒；`make up-langfuse` 约 2 分 30 秒（19 个容器都健康，迁移容器先跑完，Keycloak 导入演示 realm，Langfuse 按 `LANGFUSE_INIT_*` 创建项目）；`make seed` 4 秒：业务表（校区 8、员工 141、学员 60、作业 12、提交 198、报销 108、工单 70）、知识库从转储恢复（28 份文档、39 个块、39 个向量）、28 个原文件放进对象存储；28 份文档都是 `ready`。从清理开始到可以提问约 3 分钟。
- **之后**：用演示账号提问得到带引用的回答，引用的原文能打开（HTTP 200）；浏览器冒烟 3/3 通过。
- **没验证到**：(a) **不是真正的新机器**——镜像和 uv 缓存都在本机，真正的新机器要先拉镜像并构建（这台机器上一次 API 镜像构建就花过约 40 分钟，主要是下载 Python 依赖时网络慢；Dockerfile 现在把依赖单独成层并用 uv 缓存挂载，之后改代码不会再重下）；(b) "只需要填写 LLM 密钥"：`make seed` 本身不需要密钥，提问需要 `OPENAI_API_KEY`，我没有在一份没有 `.env` 的目录里从头验证 `make env`；(c) 没有在 Linux 或 Windows 上试过。

## 2. 各角色提问，得到带引用的回答或明确的拒绝，且每次运行都有 End 状态

- **做法**：完整评测 `starit-eval all`，114 道文档题由 7 个角色（student、staff、manager、hr、finance、Admin、RAGETLAdmin）的演示账号提问，另有 41 道数据题。
- **结果**：**结束状态合法 114/114**（每次运行都有 `end_state`，且 `end_reason` 与状态匹配）；答案通过 99/114，数据题 41/41。没通过的 15 题逐条读过，没有一题是权限泄露，分类见 [评测记录](README.md)。
- **没验证到**：答案正确性里 48 题由模型判官判断，**20% 的人工抽查还没有做**；`understand` 对 4/87 道可直接回答的题过度反问澄清，已知、未修。

## 3. `RAGETLAdmin` 能在文档管理页上传、改权限、删除、重新入库，并看到入库状态和失败原因

- **做法**：后端 82 个文档 API 测试（7 个角色 × 7 个管理端点、上传校验、完整流程、改权限、删除、重新入库、列表过滤）；前端 Vitest（编辑、任务与错误原因、删除确认等）；Playwright 对真实 Compose 栈：`RAGETLAdmin` 登录 → 上传 → 等到 `ready` → 删除（有确认），普通用户看不到菜单、直接请求得 403；真实检查里上传一个小文档用真实嵌入入库。
- **结果**：全部通过（在清空重来的栈上也重跑了一遍浏览器测试 3/3）。
- **没验证到**：**编辑权限、重新入库、查看失败原因没有在真实浏览器里点过**——它们由 API 测试和 Vitest 覆盖，Playwright 只覆盖了上传、读取引用、删除。

## 4. 权限回归全部通过，`Admin` 账号读不到受限文档内容

- **做法**：114 题 × 7 个角色 × 3 种不用模型的检索模式 = 2,394 次检索，逐个返回的块用独立的规则（从 README 的权限表写出，不用被测代码）检查；四种模式（含重排）的逐题检查；视图层逐账号对照；API 层的 404 规则。
- **结果**：**越权块 0**（完整评测报告、`make test` 里的同一检查、CI）。`Admin` 和 `RAGETLAdmin` 的提问都被拒绝（评测里各有一题，通过）；`RAGETLAdmin` 读文档正文得到 404、读元数据得到 200（API 测试和浏览器测试）。
- **没验证到**：权限检查是我写的规则对我写的实现，两边都可能犯同一个错；没有第三方审计。校区范围对**文档**没有单独的测试矩阵（样例文档的校区范围都是 `all`）。

## 5. 评测命令能运行并产出报告，包含检索模式对比

- **结果**：`starit-eval all`、`answers`、`matrix`、`retrieval`、`agent`、`data` 都能运行；完整报告里有四种检索模式的对比（hit@1 0.862 / 0.885 / 0.943 / 1.0，MRR 0.916 / 0.940 / 0.971 / 1.0），矩阵里有分块大小、`identifiers` 加权、派生内容的对比；结果写入 `ai.eval_runs`。
- **没验证到**：样本很小（114 题，各题型 7–35 道），**不对准确率下结论**；与之前 RAGFlow 试用结论的逐条对照没有做（本里程碑没有重新跑 RAGFlow）。

## 6. Langfuse 和 Grafana 能看到同一次运行的 trace 和指标

- **做法**：在清空重来的栈上问一个真实问题，用运行 ID（span 属性 `run_id`）在 Tempo 里按 TraceQL 找到 trace，再用同一个 trace ID 在 Langfuse 的 Observations API v2 里取出观测。
- **结果**：同一个 trace 在两边都有：Tempo 里是 api 的请求、图的每一步、每次模型调用、每条数据库语句；Langfuse 里是 33 个观测，其中 3 个是 `GENERATION`（带模型名 `openai/gpt-6-luna` 和 token 数），会话 ID 等于对话 ID。数据类问题的 trace 跨 api 和 mcp-server 两个服务（实测）。Prometheus 里有 `starit_runs_total`、`starit_llm_*`、`starit_retrieval_*`、`starit_tool_calls_total`、HTTP 指标；Grafana 的 4 个仪表盘都已加载，每个查询都能执行（只有"入库任务"一个面板在没有入库时是空的，跑过浏览器测试里的上传之后有数据）。
- **没验证到**：Grafana 的仪表盘**没有人眼看过渲染效果**（只验证了仪表盘存在、查询语法正确、有数据）；Langfuse 里的评测分数没有写入（只接了 trace，没有把评测结果推过去）；Loki（日志）没做。

## 7. 单元和图结构测试在 CI 中通过

- **结果**：本机 793 个 Python 测试（含需要数据库的集成测试）、61 个前端测试、3 个浏览器测试全部通过；ruff、mypy（严格）、前端 lint、类型检查、格式检查、生产构建都干净。GitHub CI 的 `ai-module` 和 `web` 两个作业在 `m8-eval-observability` 分支上成功（最后一次推送 4 分 08 秒）。CI 不跑真实模型的评测，不跑 Playwright（没有完整的 Compose 栈）。
- **没验证到**：CI 在 Linux 上跑 Python 部分，没有在 Windows 上跑过。

## 已知的限制（没有解决，也不假装解决了）

- 令牌放在浏览器的 `sessionStorage`；`npm audit` 有几条开发工具和 Next.js 自带 PostCSS 的提示（只涉及不可信 CSS 输入，本项目不处理），没有强制升级。
- 校区检查对"按城市名间接指向别校"的 SQL 只是尽力而为（真正的保护是数据库视图，漏过去的结果是空数据，不是别校的数据）。
- `understand` 的过度反问和生成步骤偶尔在没有答案时仍标 `sufficient`。
- Langfuse 和 Grafana 的凭据、LiteLLM 的主密钥都是仅限本地的固定值，**对外暴露前必须改**。
- lite profile（Oracle k3s）和它的身份方案是单独排期的，不在第一阶段范围内。
