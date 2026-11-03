# 里程碑清单记录

每个里程碑开始前，把"要新建和修改的文件、要运行的命令、验证标准、开始前不确定的事"列出来并存在这里，用户确认后才写代码。完成后补充"实际结果"（与计划不一致的地方单独写明）。新里程碑追加在文末。

依据：[07 实施计划](07-implementation-plan.md)。

---

## M0 脚手架与基础设施

状态：**已完成并合并**（标签 `ai-m0`，合并提交 `6812320`，2026-11-02）。

### 计划的文件（`ai-module/` 下，除非另写）

| 文件 | 作用 |
|---|---|
| `.python-version` | 固定 3.12 |
| `pyproject.toml` | uv workspace 根；Ruff、pytest、mypy 配置 |
| `Makefile` | `up`、`down`、`test`、`lint`、`migrate` 等 |
| `.env.example` | 变量说明与默认值 |
| `packages/core/`（`config.py`、`db.py`、`logging.py`、`tests/`） | 配置加载、数据库连接、带 `request_id` 的日志 |
| `apps/api/`（`main.py`、`tests/`） | FastAPI，`/healthz` 检查数据库 |
| `apps/worker/`、`apps/mcp-server/` | 最小入口和导入测试（功能留到 M3、M6） |
| `migrations/`（`alembic.ini`、`env.py`、`versions/0001_baseline.py`） | 创建 `ai`、`biz` schema 和 `vector` 扩展 |
| `deploy/compose/compose.yaml` | Postgres+pgvector、Redis、对象存储、api，均带健康检查 |
| `deploy/docker/python.Dockerfile` | 用 uv 构建 Python 服务镜像 |
| 仓库根 `.pre-commit-config.yaml` | Ruff、格式检查、密钥扫描 |
| 仓库根 `.github/workflows/ci.yml` | 检查、测试、迁移在空库运行 |
| `README.md`（`ai-module/`） | 开发环境启动说明 |

### 计划的命令

```bash
git switch -c m0-scaffold
uv sync
make lint && make test
make up
make migrate
curl localhost:8000/healthz
```

### 验证标准

1. `make up` 后所有服务 healthy，`/healthz` 返回成功且包含数据库状态。
2. `make test` 全部通过，`make lint` 无报错。
3. `make migrate` 在空库上成功，存在 `ai`、`biz` schema 和 `vector` 扩展。
4. 提交含假密钥的文件时，pre-commit 会拦截。
5. CI 在 GitHub 上变绿。

### 开始前不确定的事

镜像标签、MinIO 镜像是否还能拉取。

### 实际结果

| 项 | 结果 |
|---|---|
| 验证标准 1–5 | 全部满足：lint 与 mypy 通过；11 个测试通过（含集成测试）；四个容器 healthy；迁移可重复运行；gitleaks 拦截了假的 GitHub 令牌；CI 通过 |
| **与计划不一致** | 官方 MinIO 镜像已无法拉取，改用 MinIO 兼容分支 `pgsty/silo`（固定版本）；已先改设计文档 01（4.7 节）再写代码 |
| **与计划不一致** | CI 原本只在 `main` 和 PR 上触发，分支推送不会运行，已改为所有推送都触发 |
| 镜像版本 | `pgvector/pgvector:0.8.7-pg17`、`redis:7-alpine`、`pgsty/silo:RELEASE.2026-08-06T00-00-00Z` |
| pre-commit 版本 | 初稿里的版本过旧，用 `pre-commit autoupdate` 更新（ruff v0.17.3、gitleaks v8.30.0、pre-commit-hooks v6.0.0） |

---

## M1 身份

状态：**已完成，待合并**（分支 `m1-identity`）。

### 计划的文件（`ai-module/` 下，除非另写）

| 文件 | 作用 |
|---|---|
| `deploy/compose/compose.yaml`（改） | 增加 `keycloak` 服务，api 依赖它 |
| `deploy/compose/keycloak/starit-realm.json`（新） | realm：7 个角色、测试账号、客户端、受众 |
| `packages/core/src/starit_core/auth.py`（新） | JWT 校验、`Identity`、FastAPI 依赖 `get_identity` 与 `require_roles` |
| `packages/core/src/starit_core/config.py`（改） | 增加 OIDC 相关配置 |
| `packages/core/pyproject.toml`（改） | 增加 `PyJWT[crypto]` |
| `apps/api/src/starit_api/main.py`（改） | 增加 `GET /me` |
| `packages/core/tests/test_auth.py`（新） | JWT 校验单元测试（本地生成密钥，不需要 Keycloak） |
| `apps/api/tests/test_me.py`（新） | `/me` 单元测试 |
| `apps/api/tests/integration/test_keycloak.py`（新） | 用真实 Keycloak 取令牌，验证每个账号的 `/me` |
| `scripts/token.sh`（新） | `make token ACCOUNT=staff.sh` 取测试令牌 |
| `.env.example`、`Makefile`、`README.md`（改） | 新增变量和命令说明 |
| `.github/workflows/ci.yml`（改） | CI 中启动 Keycloak 并运行集成测试 |
| `docs/design/01-architecture-and-repo.md`（改） | 记录 M1 的实现决定 |

### 具体设计

- **Keycloak**：`quay.io/keycloak/keycloak:26.8.1`，`start-dev`，内置文件数据库放在容器卷里；`KC_HOSTNAME` 固定为 `http://localhost:8080`，使令牌的签发者固定；后端用 `STARIT_OIDC_ISSUER`（校验签发者）和 `STARIT_OIDC_JWKS_URL`（拉取公钥，容器内用 `http://keycloak:8080/...`）两个配置。
- **角色**：`student`、`staff`、`manager`、`hr`、`finance`、`Admin`、`RAGETLAdmin`。
- **令牌内容**：角色、`campus_id`、`level`（来自用户属性，需开启非托管属性）。受众同时包含 `starit-api` 和 `starit-mcp`。
- **测试账号**：`student.sh`（SH）、`staff.bj`、`staff.sh`、`manager.sh`、`hr.bj`、`finance.bj`、`admin.bj`、`ragetl.bj`。密码为固定的演示值，仅用于本地。
- **客户端**：`starit-web`（授权码 + PKCE）；为了脚本和测试取令牌，开启密码模式，仅在本地演示的 realm 中启用，生产环境应关闭。
- **后端校验**：检查签名、过期时间、`iss`、`aud`；拒绝 `alg: none`；只认 7 个已知角色；JWKS 缓存。

### 计划的命令

```bash
git switch -c m1-identity
uv sync --all-packages
make up
make token ACCOUNT=staff.sh
curl -H "Authorization: Bearer $(make -s token USER=staff.sh)" localhost:8000/me
make lint && make test
```

### 验证标准

1. 8 个账号都能取到令牌，`/me` 返回正确的角色和校区。
2. 无令牌、过期、签名被改、签发者或受众不对，均返回 401。
3. 单元测试覆盖上述情况，不需要 Keycloak 也能运行。
4. 集成测试用真实 Keycloak 通过，CI 通过。
5. 记录 Keycloak 实际内存占用，回填到设计文档 06。

### 开始前不确定的事

- Keycloak 26.8 的 realm 导入格式和非托管属性的开启方式（对照官方文档确认）。
- Keycloak 容器没有 `curl`，健康检查的写法；启动较慢，`make up` 等待时间会变长。
- CI 里启动 Keycloak 会让每次 CI 多约一分钟。

### 实际结果

| 项 | 结果 |
|---|---|
| 验证标准 1 | 8 个账号都取到令牌，`/me` 返回正确的角色、校区和级别（集成测试逐个验证，容器里的 api 也用真实令牌验证过） |
| 验证标准 2 | 无令牌、乱码令牌、过期、签名被改、签发者错、受众错、缺少 `sub`、`alg: none`、HS256 算法混淆，均为 401（单元测试 + 真实令牌篡改的集成测试） |
| 验证标准 3 | 单元测试不需要 Keycloak，用本地生成的 RSA 密钥 |
| 验证标准 4 | 本地 43 个测试全部通过（含集成）；GitHub CI 通过（含启动 Keycloak，用时约 1 分 38 秒） |
| 验证标准 5 | 已回填到设计文档 06 的 2.2 节（Keycloak 约 650–675 MiB，启动约 10 秒） |
| **与计划不一致** | 命令参数名由 `USER` 改为 `ACCOUNT`（`USER` 会和系统环境变量混淆） |
| **与计划不一致** | 没有开启"非托管属性"，而是在用户属性配置里显式声明 `campus_id`、`level`，更明确 |
| **新增（计划外）** | `starit_api/errors.py` 和 `deps.py`：统一错误格式、`get_identity`、`require_roles`；取不到公钥时返回 503；`pyproject.toml` 里对 FastAPI 的 `Depends` 放宽了 ruff 的 B008 |
| 开始前不确定的事 | Keycloak 26.8.1 的 realm 导入一次成功；健康检查用管理端口 9000 加 bash 的 `/dev/tcp`，有效；`make up` 现在多等约 10–30 秒 |
| 镜像版本 | `quay.io/keycloak/keycloak:26.8.1` |

---

## M2 数据模型与权限核心

状态：**已完成并合并**（标签 `ai-m2`，合并提交 `bf6fd4d`，2026-11-02）。这是整个项目最关键的安全基础，不需要 OpenAI 密钥。

### 用户的决定（2026-11-02，对本清单初稿的回复）

| # | 问题 | 决定 |
|---|---|---|
| 1 | 数据库账号 | `starit`（所有者，迁移）、`ai_app`（应用）、`ai_sql_ro`（只读，不能登录，`SET LOCAL ROLE` 切换）。**通过** |
| 2 | 视图可见范围 | 坚持"员工只看本校区"，并据此**修改评测集和样本数据**。同时澄清：**政策文件**全公司一份，只按角色控制，与校区无关；**结构化数据和校区资料**按数据范围（全公司 / 本校区 / 仅本人）控制。`hr`、`finance`（总部职能）为全公司范围。这与企业后台常见的"数据权限"一致，**采纳** |
| 3 | 账号命名 | `<名>.<职能>.<校区>`，对应真实员工。**通过**（9 个账号，见 sample-data README） |
| 4 | 职级对照 | 1：S1、I1；2：S2、I2；3：S3、I3；4：I4；5：I5；6：M2；7：M3。**写入 README**（已写入 `sample-data/README.md`，并在设计 02 第 4 节） |
| 5 | 行级过滤 | 只用视图 `WHERE`，不用 RLS。**通过**（RLS 与视图的区别已向用户解释，以后可作为第二道保险） |

### M2.0 样本数据与评测集修订（已完成）

| 项 | 内容 |
|---|---|
| 样本数据 | HR、财务、IT、教务办 5 名总部职能员工从成都（CD）改到总部北京（BJ）；工单的校区改为**开单人所在校区**（只改 `campus_id` 列，其余随机数据不变，用校验证实） |
| 新增 | `demo-accounts.csv`：9 个演示账号，对应真实员工或学员；职级档位 |
| 评测集 | `sql-qa.jsonl` 从 16 题增加到 33 题：每题带 `asker`（账号）、`role`、`scope`、`should_answer`；全公司 16、本校区 7、仅本人 3、越权应拒绝 7；答案只按该账号可见的行计算 |
| 生成器 | `tools/generate_structured.py` 增加数据范围函数 `visible()`（与视图规则一致）；脚本带断言，演示账号指向的人变了会立即报错；运行两次结果相同（确定性） |
| README | `sample-data/README.md` 新增"Who can see what""Job levels""Demo accounts"；顶层与 AI 模块 README 加了指引；评测题总数 87 |
| 设计文档 | 02（三个账号、两类访问控制、过滤条件、职级对照表、视图规则、防篡改）、01（令牌增加 `employee_id` / `student_id`、账号命名）、03（`/me`）、05（评测集构成）已更新 |

### 计划的文件（`ai-module/` 下，除非另写）

| 文件 | 作用 |
|---|---|
| `migrations/versions/0002_knowledge_tables.py` | `ai.documents`、`document_chunks`（`tsv`、`identifiers`、反规范化的权限字段、`min_level_rank`）、`chunk_embeddings`、`chunk_derived`、`ingestion_jobs`，及索引 |
| `migrations/versions/0003_conversation_audit_eval.py` | `ai.conversations`、`messages`、`runs`、`audit_log`、`eval_runs`、`eval_results`；创建 `ai_app`；授权（`audit_log` 只 INSERT）；一致性检查视图 `ai.v_chunk_permission_drift` |
| `migrations/versions/0004_biz_and_sql_views.py` | `biz` 的 7 张表；`ai_sql` 的白名单视图；`ai_sql_ro` 角色（不能登录）及授权；撤销 `set_config` 的 `PUBLIC` 执行权限 |
| `packages/core/src/starit_core/permissions.py` | 访问等级展开表、职级档对照、`COMPANY_WIDE_ROLES`、**统一的检索权限过滤函数**（SQLAlchemy 表达式，不拼字符串） |
| `packages/core/src/starit_core/documents.py` | 文档服务：登记文档、修改权限或状态时**同一事务**更新文档和全部分块，并写审计 |
| `packages/core/src/starit_core/audit.py` | 写审计记录 |
| `packages/core/src/starit_core/sqlaccess.py` | 在事务里设置身份变量并 `SET LOCAL ROLE ai_sql_ro` |
| `packages/core/src/starit_core/auth.py`（改） | `Identity` 增加 `employee_id`、`student_id` |
| `packages/core/src/starit_core/config.py`（改） | `migration_database_url`、应用账号密码 |
| `migrations/env.py`（改） | 迁移用库所有者连接 |
| `scripts/seed_biz.py`（新）、`Makefile`（改） | `make seed-biz`：导入 `sample-data/structured/*.csv` |
| `scripts/build_realm.py`（新） | 从 `demo-accounts.csv` 生成 `starit-realm.json`，保证账号与样本数据一致 |
| `deploy/compose/compose.yaml`、`.env.example`（改） | api 用 `ai_app` 连接；增加迁移连接和应用账号密码变量 |
| `deploy/compose/keycloak/starit-realm.json`（重新生成） | 9 个账号，新属性 `employee_id` / `student_id` |
| `apps/api/tests/integration/test_keycloak.py`、`README.md`（改） | 账号改名后的测试和文档 |
| `packages/core/tests/test_permissions.py`（新，单元） | 展开表与 `manifest.csv` 逐行对照；职级档对照 |
| `packages/core/tests/integration/`（新，需要数据库） | 权限矩阵、文档服务、审计、视图、安全防线 |

### 计划的命令

```bash
git switch -c m2-data-permissions        # 已创建
make up && make migrate                  # 迁移现在以库所有者身份运行
make seed-biz
make test
make lint
```

### 验证标准

1. **迁移**：全新数据库上从头升级成功；降级再升级也成功。
2. **展开表**：`manifest.csv` 的 28 行逐行展开后，等于评测集的访问模型（单元测试）。
3. **权限矩阵（差分测试）**：往数据库写入覆盖各访问等级、校区范围、`allowed_users`、职级档、状态的分块，对 7 个角色 × 多个校区 × 多个职级档，用**独立写的 Python 判定**与 SQL 过滤函数比对，必须完全一致，包括 `hr`、`finance` 的全公司范围。
4. **最小权限**：`Admin`、`RAGETLAdmin`（没有其他业务角色）查不到任何文档分块；没有角色或只有未知角色的身份什么也查不到。
5. **文档服务**：修改权限或状态后，文档与所有分块同一事务一致；中途抛异常整体回滚；一致性检查视图为空。
6. **审计**：`ai_app` 能插入，**不能 UPDATE 或 DELETE**。
7. **SQL 视图**：对 9 个演示账号，各视图返回的行数与用 CSV 独立计算的预期一致（按"数据范围"表）；`ai_sql_ro` 读不到 `biz` 原表和 `ai` 的任何表；没有身份变量时视图返回空；评测集里答案可由视图查询得到的题，视图结果与 `expected_answer` 一致。
8. **防篡改**：以 `ai_sql_ro` 身份执行 `SELECT set_config('app.roles','hr',true)` 被权限拒绝；`SET LOCAL ROLE ai_sql_ro` 流程可用。
9. M1 的集成测试在账号改名和新增属性后仍通过；CI 通过。

### 开始前不确定的事

- `tsv` 做成生成列时，Postgres 要求表达式 immutable，`array_to_string` 可能不满足；若被拒绝，改用触发器维护 `tsv`。
- 在 `pg_catalog` 里撤销系统函数的执行权限，需要确认在 pgvector 镜像里可行，并且不影响 Alembic 与应用的正常使用（测试里验证）。
- 迁移里读取环境变量创建 `ai_app` 的密码，需要确认写法在本地和 CI 都可用。
- `ai_app` 成为非超级用户后，`/healthz` 与 M1 的测试是否需要补授权。
- 已有的 `starit-ai_pgdata` 数据卷里是 M0、M1 的旧库：迁移是向前的，不需要清空；但 Keycloak 的卷里旧 realm 不会重新导入，账号改名后需要 `make clean` 或删除 `keycloakdata` 卷（只丢失演示数据）。

### 实际结果

**验证标准**（全部满足；本地 117 个测试全部通过，含集成测试；M1 为 43 个）：

| # | 结果 |
|---|---|
| 1 迁移 | 全新数据库上升级、降级到 0001、再升级成功（自动化测试，用临时数据库）；干净环境 `make clean && make up` 也成功 |
| 2 展开表 | `manifest.csv` 28 行逐行与评测集的访问模型一致，管理角色不在任何展开结果里 |
| 3 权限矩阵 | 216 份文档（访问等级 × 校区 × 状态 × 职级要求 × 点名用户）和 384 种调用者（角色组合 × 校区 × 职级 × 用户）逐一比对，SQL 过滤与独立的 Python 规则**完全一致**，查询以 `ai_app` 角色执行 |
| 4 最小权限 | 只有 `Admin` / `RAGETLAdmin`、没有角色或只有未知角色时，查不到任何分块；被文档点名的用户除外（按设计） |
| 5 文档服务 | 修改权限或状态后文档与所有分块一致；中途失败整体回滚且不留审计记录；一致性检查视图能发现直接改库造成的不一致 |
| 6 审计 | `ai_app` 能插入；UPDATE、DELETE、TRUNCATE、SELECT 均被权限拒绝 |
| 7 SQL 视图 | 9 个演示账号 × 7 个视图，返回的行与独立计算的预期**完全一致**；评测集 26 道应回答的题中，17 道（SQL-03、07、11、12、14–26）能由视图查询得出与 `expected_answer` 相同的结果；7 道应拒绝的题，对应数据对提问者不可见（行数为 0） |
| 8 防篡改 | 查询里调用 `set_config` 被拒绝；`ai_sql_ro` 读不到 `biz` 原表、`ai` 的任何表、`public` 的表 |
| 9 M1 与 CI | M1 的集成测试在账号改名后通过；GitHub CI 通过（含 Keycloak、全部集成测试，用时约 1 分 49 秒） |

**变异检查**：临时削弱过滤规则（去掉职级、让所有人享有全公司范围、放行草稿、忽略点名用户），差分测试每次都失败，说明测试能发现这类退化；之后已恢复。

**与计划不一致或新增的地方：**

| 项 | 说明 |
|---|---|
| 迁移划分 | 数据库角色在 0002 创建（计划在 0003）；降级**不删除**集群共享的角色 |
| `up` 流程 | compose 新增一次性的 `migrate` 服务，API 等它完成；否则全新环境里应用账号还不存在，API 无法通过健康检查 |
| 辅助函数授权 | 视图里调用的 `ai_auth` 函数以调用者权限执行，所以对 `ai_sql_ro` 开放了 `USAGE` / `EXECUTE`（它们只读调用者自己的身份）；因此去掉了"不能调用 `ai_auth.has_role`"的测试项 |
| 生成列 | `array_to_string` 非 IMMUTABLE，用声明为 IMMUTABLE 的包装函数解决（开始前的不确定项，已验证可行） |
| `set_config` 限制 | 撤销 PUBLIC 的执行权限可行，已被测试证明有效 |
| 评测题 SQL-31 | 学员问"我的校区有多少讲师"，原题（学员数）会被学员自己的一行数据误答，改成员工表的问题，并重新生成评测集 |
| 命令 | `make seed-biz` 为本地开发新增；账号改名后，已有环境需要 `make clean` 重新导入 Keycloak realm |
| 新增脚本 | `scripts/build_realm.py` 从 `demo-accounts.csv` 生成 realm，账号与样本数据始终一致 |

**已知限制（诚实记录）：**
- Postgres 无法用权限禁止对自定义配置项 `app.*` 的 `SET` 语句。当前防线是：`set_config` 只授予 `ai_app`；执行入口只接受单条 `SELECT`（测试覆盖了拒绝多语句和 `SET` 的入口检查，**不是数据库本身拒绝 `SET`**）。语句校验（视图和函数白名单）在 M6 加入。
- 评测集中 9 道应回答的题（SQL-01、02、04、05、06、08、09、10、13）的答案核对留到 M6，那时 SQL Agent 才会生成对应的查询。
- 旧版 `.env` 里的 `STARIT_DATABASE_URL` 仍指向库所有者，需要手动改（README 已说明）。


---

## M3 入库管线

状态：**已完成并合并**（标签 `ai-m3`，合并提交 `9dd000a`，2026-11-03）。本里程碑开始使用 OpenAI 密钥（本地 `.env` 里已配置，不会提交；检查时只确认非空，没有显示）。

### 开始前的调研结果（已核对）

| 项 | 结果 |
|---|---|
| 样例文档 | 28 份：docx 10、pdf 7、md 6、txt 5；全部 `campus_scope = all`；`HR-REC-001` 有两个版本（v1.0 superseded、v2.1 active）；文本总量约 9,000 词、55 KB |
| md / txt | 开头是元数据块（`key: value`，md 用 `---` 包起来），与 `manifest.csv` 重复；md 有标题和表格；txt 用 `1. 标题` 这样的编号行做标题，**列表项也用同样的编号**，需要靠规则区分 |
| **docx（问题）** | 抽查两份：**没有任何标题样式**（全部是 `Normal`），**表格被压成了单独的段落**（`tables: 0`）。原因是样例用 macOS `textutil` 转换，丢失了结构。标题只能靠字号和加粗推测，表格要从相邻的小字号段落还原 |
| pdf | 用 pdfplumber 可以抽取：字号 20 为标题、14 为小节标题、11 为正文，**表格能被识别**（第一页 3 个） |
| tiktoken | 可用（`cl100k_base`，首次使用需要联网下载词表） |
| litellm | 1.106.6 能在本机（arm64）安装，导入约 5 秒 |
| boto3 | 可用 |
| 费用估算 | 全部文档约 9,000 词，折合 1.2–1.5 万 token；`text-embedding-3-small` 的价格我记得是每百万 token 0.02 美元（**未联网核对**），所以整套入库的 embedding 费用不到 0.01 美元；实际调用前会先打印精确 token 数和估算，等你确认 |

### 需要先确认的问题

1. **docx 样例要不要重新生成？** 现在的 docx 没有标题样式和真实表格，解析器只能靠字号猜。真实企业的 docx 通常有标题样式和表格。建议把 `build_documents.py` 的 docx 部分改用 `python-docx` 生成（真实的 Heading 样式、真实的表格），10 个 docx 会被重新生成，内容不变，也不再依赖 macOS 的 `textutil`。解析器两种情况都处理：优先用标题样式，没有样式时用"加粗、较大字号、编号开头"的规则兜底。**建议这样做。**
2. **embedding 用 litellm 库**（设计 01 的 4.2 决定：代码依赖统一接口，lite 用进程内的 litellm），提供方和模型都由变量配置。备选是直接用 `openai` SDK，更轻但绑定供应商。**建议 litellm。**
3. **派生内容（摘要、假设性问题、关键词）在 M3 只留阶段占位，默认不生成**。它需要聊天用的 LLM 客户端（M5 才有），而且设计 05 规定要用评测证明有用再开启。**建议放到 M8 实现并评测。**
4. **对象存储**：原始文件上传到本地的 S3 兼容存储（`starit-documents` 桶），数据库里记 `object_key`。用 `boto3`，桶在 worker 启动时自动创建。

### 计划的文件（`ai-module/` 下，除非另写）

| 文件 | 作用 |
|---|---|
| `sample-data/tools/build_documents.py`（改） | docx 改用 python-docx 生成（真实标题样式和表格）；重新生成 10 个 docx |
| `packages/core/src/starit_core/ingest/models.py`（新） | `Block`（标题、段落、列表项、表格、代码）、`ParsedDocument`、`Chunk` 数据类 |
| `packages/core/src/starit_core/ingest/parsers/`（新）：`base.py`、`markdown.py`、`text.py`、`docx.py`、`pdf.py`、`registry.py` | 解析器接口和四种实现，按扩展名选择；去掉与 `manifest.csv` 重复的元数据块 |
| `packages/core/src/starit_core/ingest/clean.py`（新） | 清洗：多余空白、不可见字符、页眉页脚重复行；**不改写正文** |
| `packages/core/src/starit_core/ingest/chunker.py`（新） | 结构化分块：按标题切分，300–500 token、重叠约 50；表格和代码块不拆；`heading_path`、页码 |
| `packages/core/src/starit_core/ingest/identifiers.py`（新） | 编号抽取（连字符大写编号、18 位编号），并加入文档自己的 `doc_code` |
| `packages/core/src/starit_core/ingest/tokens.py`（新） | 用 tiktoken 计数 |
| `packages/core/src/starit_core/embeddings.py`（新） | `EmbeddingClient` 接口；litellm 实现；确定性的假实现（测试用，不花钱） |
| `packages/core/src/starit_core/storage.py`（新） | S3 客户端：确保桶存在、上传、下载 |
| `packages/core/src/starit_core/ingest/pipeline.py`（新） | 阶段：parse → clean → chunk → derive（占位）→ embed → write；**写入在一个事务里替换旧分块**；每个阶段更新 `ingestion_jobs.stage` |
| `packages/core/src/starit_core/ingest/queue.py`（新） | 任务队列：`FOR UPDATE SKIP LOCKED` 领取、重试与退避、失败记录阶段和原因 |
| `apps/worker/src/starit_worker/main.py`（改） | 轮询循环；`--once` 处理完队列就退出 |
| `scripts/ingest_samples.py`（新）、`Makefile`（改：`make ingest-samples`） | 读取 `manifest.csv`，登记文档、上传原文件、创建任务（与以后的上传接口走同一条路径） |
| `deploy/compose/compose.yaml`、`.env.example`（改） | 增加 `worker` 服务；增加 embedding 相关变量 |
| `packages/core/src/starit_core/config.py`（改） | `embedding_provider`、`embedding_model`、`embedding_dimensions`、批大小、分块参数 |
| `packages/core/pyproject.toml`、`apps/worker/pyproject.toml`（改） | 依赖：`python-docx`、`pdfplumber`、`markdown-it-py`、`tiktoken`、`litellm`、`boto3` |
| `packages/core/tests/ingest/`（新，单元）、`packages/core/tests/integration/test_ingest_*.py`（新） | 见验证标准 |
| `sample-data/README.md`、`ai-module/README.md`、设计 05（改） | 说明 docx 的变化、入库命令 |

### 关键设计决定（建议）

- **编号抽取**：正则覆盖 `ERR-PORTAL-403`、`TS-NET-009` 这类连字符大写编号，以及税号这类 18 位字母数字编号；用评测集里的关键词题（`ERR-PORTAL-403`、`ERR-PORTAL-429`、税号 `91510000FAKE00001X`）作为测试用例。
- **向量化文本**：`标题路径 + 正文`；存储的 `text` 是纯原文（设计 05 的 1.4）。
- **元数据块**：解析时去掉，不进入分块；但文档标题进入标题路径，`doc_code` 进入 `identifiers`，所以按文档编号检索仍然有效。
- **幂等**：同一 `(doc_code, version)` 且 `content_hash` 相同则跳过；内容变了则更新并重新入库；新分块在同一事务里替换旧分块，失败时旧分块保持不变。
- **并发**：两个 worker 同时运行，同一个任务只会被其中一个领取。
- **embedding 的批量和重试**：批大小可配；单批失败按退避重试，超过次数则任务失败，记录阶段 `embed` 和原因。
- **模型与维度**：每个向量行记录 `model` 和 `dimensions`；入库时若配置的维度与列的 1536 不一致则直接失败并提示（换维度需要新的迁移，见设计 02 的 2.4）。
- **测试不花钱**：自动化测试和 CI 使用假的 embedding；真实调用只在我手动运行的一次（先估算、你确认）。

### 计划的命令

```bash
git switch -c m3-ingestion                 # 已创建
uv sync --all-packages
(cd sample-data && uv run --with python-docx python tools/build_documents.py)   # 重新生成 docx（需要 macOS 和 Chrome）
make up                                    # 现在包含 worker
make ingest-samples                        # 登记 28 份文档、上传、创建任务
make test && make lint
```

### 验证标准

1. **解析**：28 份样例文档全部解析成功；每份至少有一个标题和一个分块；docx 与 pdf 里的表格在分块里保持为完整的表格文本。
2. **分块**：没有分块超过上限；表格不在行中间被切开；md 的代码围栏不丢失；`heading_path` 与文档结构一致（用样例做断言）。
3. **编号**：评测集关键词题里的编号都出现在对应分块的 `identifiers` 里，且全文检索能精确命中。
4. **入库**：28 份文档全部入库成功，文档数与 `manifest.csv` 一致；每个分块的 `allowed_roles` 与展开表一致；一致性检查视图为空；`HR-REC-001` 的两个版本都在，状态分别为 `superseded` 和 `active`。
5. **幂等**：同一份文档重复入库，分块数和内容不变；修改内容后重新入库，旧分块被替换。
6. **失败处理**：放一个损坏的文件，任务以明确的阶段和原因失败；embedding 失败时，旧分块保持不变（原子替换）；超过最大重试次数后任务为 `failed`。
7. **并发**：两个 worker 同时领取任务，每个任务只被处理一次。
8. **模型记录**：每个向量行都有 `model` 和 `dimensions`；维度不一致时入库失败。
9. **真实 embedding**：先打印精确的 token 数和估算费用，你确认后，对 28 份文档运行一次，确认向量维度为 1536、数据写入成功（只确认这件事，不评估检索效果；检索评测在 M4）。
10. 本地测试、lint、mypy 通过，CI 通过。

### 开始前不确定的事

- pdfplumber 对表格的识别能否覆盖 7 份 pdf 的所有表格，需要逐份检查；识别不到的表格会退化成普通文字行，会在测试里列出。
- txt 里标题与编号列表项的区分规则，需要在 5 份 txt 上逐一验证。
- litellm 导入较慢（约 5 秒），worker 启动时间会受影响；若影响测试速度，embedding 的 litellm 实现只在真正调用时才导入。
- 容器里的 worker 镜像会因为 litellm、pdfplumber 等依赖变大，构建时间变长。
- tiktoken 首次使用要联网下载词表，CI 和 Docker 构建里也一样；离线环境需要预先缓存。

### 需要你确认

1. docx 样例重新生成（python-docx，真实标题样式和表格）。
2. embedding 用 litellm 库。
3. 派生内容在 M3 只留占位，放到 M8 评测后实现。
4. 对象存储用 boto3，桶自动创建。

### 用户的确认（2026-11-03）

四条全部接受：docx 样例用 python-docx 重新生成；embedding 用 litellm 库；派生内容 M3 只留占位、M8 评测后实现；对象存储用 boto3，桶自动创建。

### 实际结果

**验证标准**（全部满足；本地 316 个测试全部通过，含集成测试；M2 为 117 个）：

| # | 结果 |
|---|---|
| 1 解析 | 28 份样例全部解析成功；四种格式的标题、章节、小节、表格数量与 Markdown 原稿完全一致；原稿的每一行文字都在解析结果里；pdf 的表格全部识别（7 份 pdf 无遗漏）；元数据块没有混进正文 |
| 2 分块 | 39 块（目标 400 token），中位数 358、最大 453，没有超过 500；每个块都和原文逐段对得上（没有丢内容）；每个表格完整地在某个块里；表格太大时按行拆开并重复表头、代码块拆开时围栏保持成对（样例里没有这两种情况，由合成数据的测试覆盖） |
| 3 编号 | 原稿里的每个编号在四种格式的解析结果里都完整保留；评测集关键词题（`ERR-PORTAL-403`、`ERR-PORTAL-429`、税号）都能由全文索引精确命中，且命中的文档在对应的 `source_docs` 里 |
| 4 入库 | 28 份文档全部 `ready`；每个块的 `allowed_roles` 与展开表一致；一致性检查视图为空；`HR-REC-001` 的 v1.0（`superseded`）和 v2.1（`active`）都在，v2.1 的 `supersedes_id` 指向 v1.0 |
| 5 幂等 | 重复运行：28 份全部 `unchanged`、没有新任务、块完全不变；修改一份文档后只有它被更新，其他文档的块行保持原样；`--force` 会重新向量化 |
| 6 失败处理 | 损坏的 pdf：任务 `failed`，阶段 `parse`，原因 `parse_failed`，只尝试 1 次；找不到存储的文件：`object_missing`；向量化失败：按退避重试，3 次后 `failed`，**旧块始终保持不变**（原子替换）；没有文本、文档被删除等也有对应的原因码 |
| 7 并发 | 两个 worker 同时处理 6 个任务：各自都领到任务，每个任务只尝试 1 次，只有 6 条入库审计 |
| 8 模型记录 | 每个向量行记录 `model` 和 `dimensions`；配置的维度（768）与列（1536）不一致时任务直接失败，原因 `unsupported_dimensions`，不重试 |
| 9 真实 embedding | 先精确计数：**11,537 token**，估算费用约 **0.00023 美元**（价格 0.02 美元 / 百万 token，来自 OpenAI 模型页面，经搜索核对）；你确认后重新入库一次（28 次调用，每份文档一次）：39 个向量，模型 `text-embedding-3-small`，宽度 1536，模长在 0.9995–1.0005 之间，没有零向量，没有失败、没有告警 |
| 10 工程检查 | lint、mypy 通过；GitHub CI 通过（含 Keycloak 和全部集成测试，用时约 2 分 38 秒） |

**与计划不一致或新增的地方：**

| 项 | 说明 |
|---|---|
| 分块目标 | 样例文档很短，按章节切分只有 50 token 的中位数，所以实现了"章节边界在达到目标大小后才断开"，默认目标 400；`chunk_target_tokens=0` 即一节一块，留给 M4 做分块大小的对比实验 |
| pdf 编号换行 | 覆盖测试发现 `FIN-TAX-008` 会在连字符处换行并被拼成 `FIN- TAX-008`，已修复并加了专门的测试 |
| 变量名 | embedding 变量按设计 06 不带 `STARIT_` 前缀（`EMBEDDING_PROVIDER` 等） |
| 新增 | `make ingest-samples` 的 `--force`（换模型后全部重新向量化）、`--process`（在本机直接处理队列）；`register_from_manifest` 可复用于以后的上传接口 |
| 测试隔离 | 真实入库之后，开发数据库里有了真实的文档，M2 的几个集成测试（权限差分、编号检索）一度因此失败；现在这些测试在各自回滚的事务里先清空知识库再开始，真实数据不受影响（测试后仍是 28 份文档、39 个块） |
| 测试方式 | 入库的集成测试在一次性的 scratch 数据库里运行（流水线自己提交事务，不能放进回滚的事务）；自动化测试和 CI 一律使用假 embedding，不花钱 |

**已知限制（诚实记录）：**
- pdf 的段落拼接和 txt 的小标题识别靠版面和规则，只在这 28 份样例上验证过；换一种排版的真实文档可能需要调整。
- 第一次运行需要联网下载分词词表（tiktoken），离线环境要预先缓存。
- worker 镜像因为 litellm、pdfplumber 等依赖变大，构建时间变长。
- 真实 embedding 只确认了"写入成功、维度和模长正常"，检索效果在 M4 评测。
- 本机的 `ai.ingestion_jobs` 里有 56 条记录：28 条是先用假 embedding 干跑的，28 条是真实运行；不影响后续（向量已被真实模型的结果替换）。


---

## M4 检索与首个评测切片

状态：**清单待用户确认**（分支 `m4-retrieval`）。这是第一次能看到检索的实际效果：关键词、向量、hybrid、hybrid + Rerank 四种模式的对比，也是项目的学习目标之一。

### 开始前的调研结果（已核对）

| 项 | 结果 |
|---|---|
| 评测集 `qa-set.jsonl` | 54 题：single 31、multi 7、access 7、keyword 3、unanswerable 3、version 2、paraphrase 1；每题 1 个来源文档的 43 题，2 个来源的 8 题，没有来源（无答案）的 3 题；`should_answer = false` 共 6 题（3 道 access：DOC-46、47、50；3 道 unanswerable） |
| 知识库现状 | 28 份文档、**只有 39 个块**，平均 286 token。候选列表（各 30 个）几乎覆盖全部块，Rerank 的输入（20 个）超过一半的知识库——**这个规模下四种模式的差距会被压缩，很多题会直接命中**，要如实看待结果；更有说服力的对比要等 M8 扩充评测题和文档之后 |
| 关键词查询 | 问题文本用 `plainto_tsquery('english', 问题)` 再把 `&` 换成 `\|` 得到"任一词命中"的查询，例如 `What does ERR-PORTAL-403 mean?` 变成 `'err-port' \| 'err' \| 'portal' \| '403' \| 'mean'`（已在数据库里验证）；用 AND 会因为问句里的虚词而几乎查不到 |
| 排序 | `ts_rank_cd`（设计 05 已定方案 A），再给 `identifiers` 精确命中的块加分 |
| 评测身份 | 评测集只有角色没有账号；按角色对应到演示账号：student → `wei.stu.sh`、staff → `ning.adm.bj`、manager → `ling.mgr.bj`、hr → `qing.hr.bj`、finance → `ning.fin.bj`（样例文档的校区范围都是 `all`，所以校区不影响结果） |

### 需要先确认的问题

1. **评测运行器作为 uv 工作区的新成员 `eval/`**（设计 01 的目录结构里就有 `eval/`），命令行 `starit-eval`。
2. **现在就加一个最小的聊天模型客户端 `starit_core/llm.py`**（只做"发消息、取文本"，带假实现）。Rerank 需要它，M5 再扩展成流式和工具调用。
3. **Rerank 默认模型 `openai/gpt-4o-mini`**（环境变量 `STARIT_MODEL_RERANK` 可改）。开始前我会先查你的密钥能用哪些模型（列出模型的接口是免费的），不能用就换。
4. **在 M4 里实现"被权限过滤的内容"探测**（设计 04 的 5.1，用来区分 `no_permission` 和 `not_found`）：只返回数量和最高分，**绝不返回文本**，不进提示词，只用于审计和统计。
5. **评测的权限回归扫描**：把 54 个问题分别用 7 个角色（5 个业务角色 + `Admin` + `RAGETLAdmin`）各问一遍，检查返回的每个块是否都被独立的 Python 规则允许，**零容忍**。这一项用关键词、向量、hybrid 三种模式做（只查数据库，几乎不花钱）；Rerank 只重新排序已通过过滤的候选，不改变权限，所以不重复扫。
6. **分块大小对比实验（目标 400 与一节一块）是否放在 M4 做？** 重新入库一次约 0.0002 美元，然后重跑评测。我的建议是**放在基线出来之后做一次**，结果写进报告；你也可以推到 M8。

### 计划的文件（`ai-module/` 下，除非另写）

| 文件 | 作用 |
|---|---|
| `packages/core/src/starit_core/permissions.py`（改） | `chunks` 表对象补全检索需要的列（文本、标题路径、页码、编号、`tsv` 等），保证权限条件和检索查询用**同一个表对象**，避免生成笛卡尔积 |
| `packages/core/src/starit_core/retrieval/models.py`（新） | `Candidate`、`RetrievedChunk`（含各路得分）、`RetrievalResult`（块、诊断信息） |
| `packages/core/src/starit_core/retrieval/keyword.py`（新） | `KeywordSearcher` 接口；`ts_rank_cd` 实现（OR 查询 + 编号加分） |
| `packages/core/src/starit_core/retrieval/vector.py`（新） | 向量检索（余弦距离，精确扫描） |
| `packages/core/src/starit_core/retrieval/fusion.py`（新） | RRF 融合 |
| `packages/core/src/starit_core/retrieval/rerank.py`（新） | `Reranker` 接口；LLM 列表式重排（要求返回 JSON，容错解析；失败时退回融合顺序并标记） |
| `packages/core/src/starit_core/retrieval/assemble.py`（新） | 上下文组装：去重、按分数取前 N、token 预算、附带文档标题、版本、状态、标题路径 |
| `packages/core/src/starit_core/retrieval/probe.py`（新） | 被权限过滤内容的探测：只返回数量和最高分 |
| `packages/core/src/starit_core/retrieval/search.py`（新） | 入口 `retrieve(identity, query, mode, ...)`：所有检索都必须带身份 |
| `packages/core/src/starit_core/llm.py`（新） | 最小聊天客户端接口 + litellm 实现 + 假实现 |
| `packages/core/src/starit_core/config.py`（改） | `retrieval_mode`、各路候选数、`rrf_k`、`rerank_in`、`final_k`、上下文预算、`model_rerank` |
| `eval/pyproject.toml`、`eval/src/starit_eval/`（新）：`cli.py`、`dataset.py`、`metrics.py`、`runner.py`、`report.py` | 评测运行器：读取评测集，按角色换成演示账号身份，逐题检索，计算指标，写 `ai.eval_runs` / `ai.eval_results` 和 Markdown、JSON 报告 |
| `pyproject.toml`（改）、`Makefile`（改） | 工作区成员；`make eval ARGS="..."` |
| `packages/core/tests/retrieval/`（新，单元）、`packages/core/tests/integration/test_retrieval*.py`（新） | 见验证标准 |
| `eval/tests/`（新） | 指标计算和报告的测试 |
| `docs/eval/`（新） | 基线报告（Markdown），随结果提交 |
| `docs/design/05`、`ai-module/README.md`（改） | 实现记录、使用方式 |

### 检索流程（沿用设计 05 的 2.1，默认参数不变）

```
问题 ─┬─▶ 关键词检索（权限过滤后）前 30 ─┐
      │                                    ├─▶ RRF（k=60）─▶ Rerank 前 20 取前 6 ─▶ 上下文组装（预算 3500 token）
      └─▶ 向量检索（权限过滤后）前 30 ───┘
```

- 四种模式 `keyword`、`vector`、`hybrid`、`hybrid_rerank`（默认）；所有数值都是配置项。
- 过滤放在两路检索各自的 `WHERE` 里，**先过滤再排序**；旧版本默认参与检索并带 `status`，草稿不参与。
- Rerank 失败（输出不是合法 JSON、漏了编号、重复编号、模型报错）：退回 RRF 顺序，结果上标记 `rerank_failed`，不让一次重排失败变成整次检索失败。

### 评测指标（设计 05 的 4.3，检索部分）

- `hit@k`（`k` 取 1、3、6：前 k 个结果里是否出现任一来源文档）、`recall@k`（多来源的题，来源文档出现的比例）、MRR；按题型分别统计。
- `unanswerable` 和 `should_answer = false` 的题不算召回，单独记录它们的最高分（M5 的 `grade_retrieval` 阈值要用）。
- **权限回归**：见确认问题 5；任何泄露都算失败。
- 延迟：检索（数据库）和 Rerank 的 p50 / p95。
- 每次运行记录配置（模式、参数、模型、git 提交号）和每道题的结果，可以横向对比。

### 计划的命令

```bash
git switch -c m4-retrieval                       # 已创建
uv sync --all-packages
make test && make lint
make eval ARGS="retrieval --all-modes"          # 先打印调用数和估算费用，等确认
make eval ARGS="retrieval --leak-sweep"         # 权限回归扫描（只查数据库）
```

### 验证标准

1. 四种模式都能运行，每次返回不超过 `final_k` 个块，字段齐全（文档标题、版本、状态、标题路径、页码、各路得分）。
2. **权限回归零泄露**：54 个问题 × 7 个角色，关键词、向量、hybrid 三种模式返回的每个块都被独立规则允许（自动化测试里用合成数据覆盖更多情形，评测里用真实数据）。
3. **关键词题**：`ERR-PORTAL-403`、`ERR-PORTAL-429`、税号三题，hybrid 前 3 个结果里有来源文档（自动化测试里用假向量也能通过，因为靠的是关键词一路）。
4. **访问题**：学员问只有 HR 看得到的问题，返回里没有该文档的任何块，且探测显示"有被过滤的高相关内容"；HR 问同一问题能得到该文档。
5. **旧版本**：员工问旧招聘政策，返回里 v1.0（`superseded`）和 v2.1（`active`）的块都有，且带状态标注。
6. **Rerank 容错**：输出乱码、缺编号、重复编号、模型报错的情况（假的聊天客户端）都退回融合顺序并标记。
7. **探测只返回数字**：测试断言探测的返回值里没有任何文本字段。
8. **真实评测**：先打印调用数和估算费用（查询向量化、Rerank 的输入 token），你确认后运行四种模式；产出基线报告，写入 `docs/eval/` 并提交；报告里写明局限（39 个块的知识库）。
9. 本地测试、lint、mypy 通过，CI 通过。

### 开始前不确定的事

- 你的密钥能用哪些聊天模型（接口免费，开始时先查）；Rerank 默认的 `gpt-4o-mini` 如果不可用就换。
- LLM 列表式重排的提示词写法和 JSON 输出的稳定性，需要实测；每个问题的输入约 20 个块（最多 9,000 token），54 题一轮约 49 万 token。费用按 `gpt-4o-mini` 的价格估算时我会先联网核对价格，**现在不报数字**。
- `ts_rank_cd` 用 OR 查询的排序质量、对连字符编号的分词行为，需要实测（编号另有 `identifiers` 加分兜底）。
- 评测规模很小（54 题，39 个块），差距可能不明显，也可能因个别题而波动，不能据此下结论；M8 会补充评测题和文档。
- 评测要写 `ai.eval_runs` / `ai.eval_results`：应用账号对它们有读写权限（已授权），但主键是 `(run_id, question_id, role)`，同一题同一角色在同一次运行里只能有一行，多个模式要分成多次运行。

### 需要你确认

1. 评测运行器作为工作区成员 `eval/`。
2. 现在加最小的聊天模型客户端 `llm.py`。
3. Rerank 默认模型 `openai/gpt-4o-mini`（先查可用性）。
4. 实现"被过滤内容"的探测（只返回数字）。
5. 权限回归扫描：54 题 × 7 个角色 × 三种模式。
6. 分块大小对比实验：放在 M4 基线之后做一次，还是推到 M8？

### 实际结果

（完成后填写）
