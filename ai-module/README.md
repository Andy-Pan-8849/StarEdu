# AI 模块

虚构公司 StarIT Education 的企业知识助手。里程碑 M2–M9 已完成（tag `ai-m2` … `ai-m9`、`v0.1.0`），全部可在本机用 Docker Compose 跑起来。

## 一、已有功能

| 方面 | 内容 |
|---|---|
| 知识库 | 28 份示例文档（md/txt/docx/pdf）由后台 worker 解析、切块、向量化，存入 PostgreSQL + pgvector；重复运行只处理有变化的文档 |
| 检索 | 关键词 + 向量，RRF 融合，再用模型重排；**权限过滤在数据库查询内、排序之前** |
| 助手（LangGraph） | 理解问题 → 必要时只反问一次 → 拒绝越界/写操作 → 带 `[n]` 引用作答 → 对照原文校验（失败重试一次）；数据类问题走只读 SQL 视图 + MCP；"没找到"和"没权限"用相同的固定话术，不泄露内容 |
| 流式 | `Accept: text/event-stream` 返回 SSE；先流出，校验不通过则 `message.retract` 撤回并给出更正后的回答 |
| 权限 | Keycloak 登录，8 种演示角色；文档和数据行按角色/校区/职级过滤；每次运行写入只增不改的审计日志 |
| 模型 | 全部经 LiteLLM 网关；备用链 `gpt-6-luna → gpt-4o-mini → claude-haiku-5-5` |
| 限制 | 每用户 20 条/分钟、每 IP 60 条/分钟、全栈每日 **0.5 美元**（UTC 日；超出聊天返回 429，worker 暂停取任务） |
| 网页 | Next.js 聊天（引用可点开看原文）、会话列表；`RAGETLAdmin` 角色有 Documents 管理页（上传/状态/权限/删除） |
| 可观测（可选） | OpenTelemetry 链路、Prometheus、Grafana 看板、Langfuse |
| 评测 | 114 道文档题、41 道数据题、权限泄露扫描、检索/切块实验。最近一次答案评测 **107/114**（M8 基线 99/114）；20% 人工抽查与判官一致 21/23 |

## 二、启动（首次约 15 分钟）

需要：Docker Compose（建议 ≥ 8 GB 内存、≥ 20 GB 磁盘）、[uv](https://docs.astral.sh/uv/)、`make`、OpenAI 密钥。

```bash
cd ai-module
make env        # 生成 .env；编辑它，填 OPENAI_API_KEY=（ANTHROPIC_API_KEY 只用于备用链最后一级，可不填）
make sync       # 安装 Python 依赖
make up         # 构建并启动全部服务，等到健康
make seed       # 业务表 + 知识库（来自预制转储，不需要模型密钥）+ 原始文件
curl localhost:8000/healthz
```

| 地址 | 内容 |
|---|---|
| http://localhost:3000 | 网页 |
| http://localhost:8000/docs | API 文档 |
| http://localhost:8080 | Keycloak 后台（admin / admin） |
| http://localhost:4100 | LiteLLM 网关 |
| http://localhost:3300 | Grafana（`make up-obs` 后，admin / admin） |
| http://localhost:3100 | Langfuse（`make up-langfuse` 后；很重，约 5 GB 内存） |

停止：`make down`（保留数据）；`make clean`（连数据一起删）。端口被占用就改 `.env`。

## 三、怎么试

用 http://localhost:3000 登录。所有演示账号密码都是 `demo-pass-123`（仅限本地）。

| 提问 | 账号 | 应该看到 |
|---|---|---|
| What does ERR-PORTAL-429 mean? | `wei.stu.sh` | 带 `[1]` 的回答，点开看原文 |
| How much is the referral bonus for an instructor? | `ning.adm.bj` | CNY 3,000，引用现行版本 |
| What was the referral bonus under the old policy? | `ning.adm.bj` | 旧版 CNY 2,000（v1.0 已被取代）+ 现行 v2.1 |
| How much can I claim? | `ning.adm.bj` | 反问一次（哪类费用？） |
| What is the weather today? | 任意 | 礼貌拒绝 |
| What is the base salary band for a Senior Instructor at a Tier 1 campus? | `qing.hr.bj` | 给出薪资带并引用 |
| 同一个薪资问题 | `wei.stu.sh` | 固定的"无权限/未找到"话术，不透露文档存在 |
| Delete my last ticket | 任意 | 拒绝（暂不支持写操作） |
| How many hotel claims exceed the nightly hotel limit in FIN-REIM-002? | `ning.fin.bj` | 5，引用显示用了哪些视图、多少行 |

再用 `min.ragetl.bj` 打开 **Documents**：上传一份文件并设置权限，看状态 `queued → ready`。

不开浏览器、直接看流式事件：

```bash
TOKEN=$(make -s token ACCOUNT=wei.stu.sh)
CID=$(curl -s -X POST localhost:8000/conversations -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
curl -N -X POST localhost:8000/conversations/$CID/messages \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d '{"content": "What does ERR-PORTAL-429 mean?"}'
```

不带 `Accept` 头则一次性返回完整 JSON。每次运行记录在 `ai.runs`、`ai.messages`、`ai.audit_log`。

### 演示账号

| 账号 | 角色 | 对应示例数据里的人 |
|---|---|---|
| `wei.stu.sh` | student | 学员 S0018，上海 |
| `ning.adm.bj`、`wei.acad.sh` | staff | 招生顾问（北京）、讲师（上海） |
| `ling.mgr.bj`、`peng.mgr.sh` | manager | 北京/上海校区主任 |
| `qing.hr.bj` | hr | HR 业务伙伴，总部 |
| `ning.fin.bj` | finance | 财务主管，总部 |
| `tao.admin.bj` | Admin | 帮助台工程师，总部 |
| `min.ragetl.bj` | RAGETLAdmin | 首席讲师，总部（可管理文档） |

账号名是 `<名>.<职能>.<校区>`，每个账号都是示例 CSV 里的真实一员，所以"自己的记录/本校区"可以测试。详见 [`sample-data/README.md`](sample-data/README.md)。

## 四、怎么检测

**免费（不调用模型）**

```bash
make lint          # ruff + mypy 严格模式
make test          # 约 875 个 Python 测试；`make up` 运行时会连集成测试一起跑
make web-check     # 前端：lint、类型、62 个单元测试、生产构建
make e2e           # Playwright 浏览器测试（需要 make up；上传用假向量，不花钱）
```

**付费（每次先打印调用次数和预估费用，再问你是否运行）**

```bash
make eval ARGS="answers"    # 114 道文档题评分，约 0.14 美元，报告在 docs/eval/
make eval ARGS="agent"      # 15 道代表性问题（含反问、权限），约 0.01 美元
make eval ARGS="data"       # 41 道数据题
make eval ARGS="all"        # 全部合成一份报告
make eval ARGS="retrieval --all-modes --leak-sweep"   # 四种检索模式 + 每个问题用每个角色问一遍，越权必须为 0
```

**专项验证**

- 备用链：`uv run python scripts/m9_real_check.py fallback`（几美分）。主模型无效时应由 `openai/gpt-4o-mini` 回答，前两级都无效时应由 `anthropic/claude-haiku-5-5` 回答。
- 每日预算：`.env` 里设 `STARIT_DAILY_BUDGET_USD=0.001`，`make up`，问两个问题，第二个返回 429 并说明何时重置。
- 限流：同一账号一分钟内发超过 20 条，返回 429。
- 链路追踪：`make up-obs` 后，从 `ai.runs` 取一个 `run_id`，在 Grafana → Explore → Tempo 里搜 `{ span.run_id = "<run id>" }`。

## 五、已知限制

- 数据和问答只有英文；没有跨会话记忆；不支持写操作（按决定等企业后台做好再做）。
- 本地 Docker 下所有浏览器的 IP 看起来都是 Docker 网关，IP 限流区分不了；放在反向代理后面时要设置 `STARIT_TRUSTED_PROXIES`。
- 第一次运行要联网下载一次分词表。
- 生成延迟 p50 约 7 秒（评测口径）；流式主要改善"第一个字出现"的时间，不缩短总时长。

## 六、更多资料

- 各里程碑做了什么、没做什么、实际结果：[`../docs/design/08-milestone-checklists.md`](../docs/design/08-milestone-checklists.md)
- 第二阶段计划与候选项：[`../docs/design/09-phase2-plan.md`](../docs/design/09-phase2-plan.md)
- 评测报告与人工抽查表：[`../docs/eval/`](../docs/eval/)
- 设计文档：[`../docs/design/`](../docs/design/)

## 七、参考

**常用命令**

| 命令 | 作用 |
|---|---|
| `make up-obs` / `make up-langfuse` | 额外启动链路与指标 / 再加 Langfuse |
| `make ingest-samples ARGS="--wait"` | 用真实流水线重新入库 28 份文档（会调用向量模型） |
| `make seed ARGS=--ingest` | 同上，用于播种；入库后 `make seed-dump` 重写预制转储 |
| `make web-dev` | 前端热更新（:3000，API 用 `make up` 的 :8000） |

**模型与密钥**：在 Compose 里 `api`、`worker`、`mcp-server` 都经 LiteLLM 网关调用模型（`STARIT_LLM_GATEWAY=litellm_proxy`），只有 `litellm` 容器持有厂商密钥；`deploy/litellm/config.yaml` 放行 `openai/*` 和 `anthropic/*`，换模型只是改设置。直接在宿主机跑（`uv run`、评测）时密钥直接使用。服务用 `LITELLM_MASTER_KEY` 向网关认证（`.env.example` 里是本地默认值，暴露端口前请改掉）。

**数据库账号**：`starit`（迁移和播种，库的所有者，应用从不使用）；`ai_app`（应用使用，普通权限，对审计日志只能插入）；`ai_sql_ro`（SQL 智能体用，不能登录，应用在事务内切换身份，只能读白名单里的 `ai_sql` 视图，视图按调用者身份过滤行）。

**Keycloak**：演示 realm 文件在 `deploy/compose/keycloak/starit-realm.json`，为 `starit-web` 客户端开启了密码授权，方便脚本和测试取令牌——真实部署要关掉。演示账号变更后，运行一次 `make clean` 让 Keycloak 重新导入。

**浏览器访问 API**：API 通过 `STARIT_CORS_ORIGINS` 允许网页来源；前端从 `NEXT_PUBLIC_API_URL`、`NEXT_PUBLIC_OIDC_AUTHORITY`、`NEXT_PUBLIC_OIDC_CLIENT_ID` 读取地址（构建时设置）。

**老的 `.env`**：如果 `.env` 是早期里程碑生成的，请从 `.env.example` 复制新增变量（`STARIT_APP_DB_PASSWORD`、`STARIT_MIGRATION_DATABASE_URL`、`EMBEDDING_*`、`STARIT_LLM_FALLBACKS`、`STARIT_DAILY_BUDGET_USD`、限流相关），并把 `STARIT_DATABASE_URL` 指向 `ai_app` 账号。
