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

状态：**已完成并合并**（标签 `ai-m4`，合并提交 `9bdcacc`，2026-11-03）。这是第一次能看到检索的实际效果：关键词、向量、hybrid、hybrid + Rerank 四种模式的对比，也是项目的学习目标之一。

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

### 用户的确认（2026-11-03）

- **Rerank 默认模型改为 `gpt-6-luna`**，不可用时再用 `gpt-4o-mini`。已核实：这把密钥能看到 `gpt-6-luna`（模型列表接口，免费）；联网查到的价格是每百万 token 输入 0.10 美元、输出 0.50 美元（来自多个二手来源，官方价格页没有直接核对），是 GPT-6 档里最便宜的。实际能否用于重排（参数是否被接受、输出是否稳定）要在实现时用一次极小的调用验证。
- 分块大小对比实验：**放在 M4 基线之后做一次**。
- 其余 5 条（评测运行器作为 `eval/` 工作区成员；现在加最小聊天客户端；探测被过滤内容且只返回数字；权限回归扫描 54 题 × 7 角色 × 三种模式；）全部接受。
- 每次真实调用之前仍先打印调用数和费用估算，等你确认。

### 实际结果

**验证标准**（全部满足；本地 378 个测试通过；M3 为 316 个）：

| # | 结果 |
|---|---|
| 1 四种模式 | 都能运行，每次返回不超过 6 个块，字段齐全（文档标题、版本、状态、标题路径、页码、各路得分）；重排结果和退回融合顺序的情形都有测试 |
| 2 权限回归 | **零越权**。自动化测试：54 题 × 7 角色 × 3 种模式（合成数据之外还用真实的样例文档）；真实运行：两次各 1,134 次检索，独立规则检查返回的每个块，越权块 0；另外 M2 的差分测试仍通过 |
| 3 关键词题 | `ERR-PORTAL-403`、`ERR-PORTAL-429`、税号：关键词模式前 3 个里有来源；真实基线里混合模式 MRR 为 0.83（`ERR-PORTAL-429` 排第 2，见下） |
| 4 访问题 | 学员问只有 HR 看得到的问题：所有模式都没有返回该文档的块，探测显示"有被过滤的强匹配"；HR 问同一问题能得到；`Admin` / `RAGETLAdmin` 什么也得不到，探测显示内容存在 |
| 5 旧版本 | 员工问旧招聘政策，v1.0（`superseded`）和 v2.1（`active`）的块都回来了，并带状态标注 |
| 6 重排容错 | 乱码、空排名、缺编号、重复和越界编号、模型报错：都退回融合顺序并标记；真实运行 108 次重排调用（两次各 54 次），**没有一次失败** |
| 7 探测只返回数字 | 测试断言结果类型里没有文本字段 |
| 8 真实评测 | 先打印估算（调用 54 次重排、最多 329,400 输入 token、约 0.039 美元）并经你确认；基线实际用了 318,665 输入、7,546 输出 token，约 0.036 美元；分块对比实验约 0.016 美元，加上两次重新向量化约 0.0006 美元，总计约 0.052 美元；报告在 `docs/eval/` |
| 9 工程检查 | lint、mypy 通过；GitHub CI 通过（含全部集成测试，用时约 3 分 8 秒） |

**结果摘要**（详见 [`docs/eval/README.md`](../eval/README.md)）：

- 知识库只有 39 个块（一节一块时 189 块），**hit@6 全部是 1.0，指标饱和**，差别只在 hit@1 和 MRR：400 token 分块时 keyword 0.896、vector 0.917、hybrid 0.938、hybrid_rerank 1.0；一节一块时 keyword 0.833，其余三种都是 1.0。
- 重排两次都是满分，检索延迟 p50 约 2.1 秒（其余模式几十毫秒）。
- 重排分数在 48 道可回答题上全部是 10，在 6 道无答案或应拒绝的题上是 0、0、1、2、5、8，是 M5 判断证据够不够的依据，但样本很小，8 分那道说明间隔不宽。

**与计划不一致或新增的地方：**

| 项 | 说明 |
|---|---|
| 指名文档加分 | 测试发现问"FIN-REIM-002 说了什么"时，另一份只在正文里提到该编号的文档排在前面；关键词检索新增"块属于被点名的文档"再加一份分 |
| RRF 的弱点 | 基线里 `ERR-PORTAL-429` 在混合模式只排第 2：向量一路把 `ERR-PORTAL-403` 的块排第一，RRF 只看名次，压下了唯一的精确命中；重排把它纠正了。自动化测试里向量是假的随机向量，所以混合模式的编号测试只要求来源出现在结果里，不要求前 3 |
| 聊天模型参数 | `gpt-6-luna` 在开启推理时只接受 `temperature = 1`；客户端设置 `reasoning_effort = "none"` 和 `temperature = 0`，不支持的模型由 `drop_params` 忽略。极小的试调用（约 20 token）确认了这一点 |
| 代码位置 | `vector_literal` 移到 `embeddings.py`，检索模块不用依赖入库流水线 |
| 新增 | `eval/` 作为 uv 工作区成员；`make eval`；`--dry-run`（假模型演练）、`--no-db` |
| 评测记录 | 数据库里有 8 次评测运行（2 个标签 × 4 种模式），432 行结果；知识库已恢复为默认分块（39 个块、真实向量、一致性检查为空），worker 容器已重新启动 |

**用户的决定（2026-11-03）：保持目标 400 token 一块。** （以下是当时提出的问题）默认分块要不要改成一节一块？检索排名上更细的块对向量和混合有帮助，重排下两者持平，且重排输入更便宜；但一节一块时 6 个块只有约 350 token，给生成答案的上下文可能太少，而这次没有衡量答案质量。**我的建议是先保持 400 token，M5 有了答案之后，M8 再用答案质量一起对比。**

**已知限制（诚实记录）：**
- 知识库太小、评测题太少（每种题型只有几道），数字只能说明流程正确和方向，不能说明各方法在真实规模上的优劣。
- 价格来自第三方价格表，没有直接核对 OpenAI 的价格页。
- 重排的稳定性只在这 108 次调用上验证；换模型或换文档风格需要重新评估。


---

## M5 Agent 图与对话 API

状态：**已完成并合并**（标签 `ai-m5`，合并提交 `1e3d4dd`，2026-11-03）。这是项目最核心的一块：用户提问，经过固定的图，得到带引用的回答或一个明确的拒绝，每次运行都有显式的 End 状态。本里程碑会调用 OpenAI 的聊天模型（`understand` 和 `generate` 两个节点，加上 M4 已有的重排）。

### 开始前的调研结果（已核对）

| 项 | 结果 |
|---|---|
| LangGraph | `langgraph 1.2.19` 和 `langgraph-checkpoint-postgres 3.2.0` 能在本机（Python 3.12、arm64）安装并导入；`redis 8.1.0` 同样可用 |
| M4 留下的东西 | `retrieve(...)` 已经能按身份检索并返回重排分数和"被过滤内容"的探测数字；最小的聊天客户端 `llm.py` 已有 JSON 模式；`gpt-6-luna` 验证可用 |
| 可用的聊天模型 | 这把密钥能看到 `gpt-6-luna`、`gpt-6-sol`、`gpt-6.1-sol`、`gpt-6.1-terra`、`gpt-6-astra`、`gpt-4o-mini` 等。查到的标价（二手来源）：Luna 每百万 token 输入 0.10 / 输出 0.50 美元，Sol 2 / 10 美元，Astra 10 / 50 美元 |
| 数据库已有的表 | `ai.conversations`、`ai.messages`、`ai.runs`、`ai.audit_log`（02 里已建好，M2 迁移） |
| M4 的评测数据 | 重排分数在 48 道可回答题上全部是 10，在 6 道无答案或应拒绝的题上是 0–8，用来定 `grade_retrieval` 的初始阈值 |

### 需要先确认的问题

1. **不使用 LangGraph 的 Postgres checkpointer，会话状态存在 `ai.conversations` 里**（新增迁移 0005，加三列：`session_mode`、`pending_question`、`clarify_count`）。理由：第一阶段每次运行都是一次完整的、没有中断的运行（"需要澄清"也是以 End 结束，下一轮再带着补充进来），checkpointer 用不上，却要多一套表、一次 `setup()` 和版本耦合。第二阶段做"写操作确认"（`interrupt`）时再启用。这改变了设计 04 里"由 checkpointer 保存"的说法，我会同步修改设计 04。**建议这样做。**
2. **`data_query` 在 M5 先拒绝**，End 状态 `refused`，原因码临时用 `not_available_yet`（M6 实现数据查询后去掉）；`action` 意图按设计 04 返回 `refused / write_not_enabled`。
3. **历史只保留最近 6 轮（截断），暂不做滚动摘要**。设计 04 写的是"更早的用滚动摘要"，摘要要多一次 LLM 调用，样例里没有长对话，建议放到之后。
4. **默认模型**：`understand`、`generate` 都用 `openai/gpt-6-luna`（可由环境变量分别改）。生成答案对质量最敏感（RAGFlow 试用里小模型算错了迟交扣分），所以真实检查时会用同一批难题对比 `gpt-6-sol`，按结果选默认值。
5. **会话标题**用第一个问题的前 60 个字符，不调用 LLM。
6. **限流**（设计 03 第 7 节：对话接口每用户每分钟 20 次）在 M5 一起做，用 Redis 计数，超出返回 `429 rate_limited`。
7. **`grade_retrieval` 分两道关**：第一道用重排分数（初始阈值 6，参考 M4 的分布，可配置，用评测集标定）；第二道是生成节点自己返回的 `sufficient` 标志，模型判断片段不足以回答时以 `not_found / no_relevant_documents` 结束。这样阈值不用定得太紧，也不会让一个"相关但没答案"的片段（M4 里 DOC-47 得了 8 分）变成瞎编的回答。
8. **真实检查**：约 12 个代表性的问题（迟交扣分计算、旧政策版本、两个错误码、学员问 HR 文件、无答案、需要澄清、越界、问候），先给出调用数和估算费用，确认后运行。

### 计划的文件（`ai-module/` 下，除非另写）

| 文件 | 作用 |
|---|---|
| `migrations/versions/0005_conversation_state.py` | `ai.conversations` 增加 `session_mode`、`pending_question`、`clarify_count` |
| `packages/core/src/starit_core/agent/state.py` | 图状态（身份只读、会话状态、意图、检索结果、预算、答案、End 状态） |
| `packages/core/src/starit_core/agent/prompts/understand.md`、`generate.md` + `prompts.py` | 提示词文件和版本号（设计 04 第 6 节的生成规则） |
| `packages/core/src/starit_core/agent/nodes.py` | 各节点：`load_context`、`guard_input`、`understand`、`retrieve_docs`、`grade_retrieval`、`rewrite_query`、`generate`、`verify_answer` |
| `packages/core/src/starit_core/agent/graph.py` | 构建 LangGraph 图；6 个 End 节点；路由；预算与步数上限 |
| `packages/core/src/starit_core/agent/finish.py` | `finish_run`：一次事务里写 `ai.runs`、`ai.messages`、`ai.audit_log`，更新会话（时间、标题、会话状态） |
| `packages/core/src/starit_core/agent/runtime.py` | `AgentRuntime.run(identity, conversation_id, text)`：组装依赖、60 秒总超时、保证无论怎样都走到 `finish_run` |
| `packages/core/src/starit_core/conversations.py` | 会话与消息的读写（只能访问自己的会话；归档不删除） |
| `packages/core/src/starit_core/ratelimit.py` | Redis 限流（带内存版本供测试） |
| `packages/core/src/starit_core/llm.py`（改） | 返回 token 数；每次调用的超时；结构化输出辅助 |
| `packages/core/src/starit_core/config.py`（改） | `model_understand`、`model_generate`、各项上限（步数、LLM 调用数、澄清次数、重试）、`grade_min_rerank_score`、历史轮数、限流 |
| `apps/api/src/starit_api/conversations.py`（新） | 路由：`POST/GET /conversations`、`GET/PATCH/DELETE /conversations/{id}`、`POST/GET /conversations/{id}/messages` |
| `apps/api/src/starit_api/main.py`（改） | 在 lifespan 里构建运行时；注册路由；限流中间件 |
| `packages/core/pyproject.toml`（改） | 依赖：`langgraph`、`redis` |
| `packages/core/tests/agent/`（新，单元）、`packages/core/tests/integration/test_agent*.py`（新）、`apps/api/tests/test_conversations*.py`（新） | 见验证标准 |
| `eval/` 或 `scripts/`（改） | 一个小工具：把约 12 个问题真实地问一遍并打印每次的 End 状态、引用和耗时 |
| `docs/design/04`、`02`、`03`、`ai-module/README.md`（改） | 同步实现记录 |

### 图（沿用设计 04，M5 实现的部分）

```
load_context → guard_input → understand ─┬─ 需要澄清且未超限 → END_NEED_CLARIFICATION
                                          ├─ out_of_scope / action / data_query → END_REFUSED
                                          ├─ chitchat → generate
                                          └─ doc_qa → retrieve_docs → grade_retrieval
        grade_retrieval ─┬─ 足够 → generate → verify_answer → END_ANSWERED
                         ├─ 不足且可重试 → rewrite_query → retrieve_docs
                         ├─ 无内容但探测到被过滤的强匹配 → END_NO_PERMISSION
                         └─ 无内容 → END_NOT_FOUND
        generate 返回 sufficient=false → END_NOT_FOUND；校验失败重试一次，仍失败 → END_ERROR(llm_error)
        任何异常或超时 → END_ERROR
```

### 关键设计决定（建议）

- **身份只读**，来自 JWT；`understand` 只做意图、独立问题和反问，**不判断身份**。
- **同一个问题的 `no_permission` 与 `not_found` 对用户使用相同文案**（设计 04 的 5.1），差别只记在 `ai.runs` 和审计里；探测的数字只进审计，不进提示词。
- **会话状态**：`session_mode` 为 `need_clarification` 时，下一条消息被视为对 `pending_question` 的补充，合并成独立问题；连续澄清 2 次后以 `not_found / clarification_limit` 结束。
- **预算**：一次运行 LLM 调用不超过 6 次（含重排）、检索重试 1 次、校验重试 1 次、总时长 60 秒、`recursion_limit` 20；超出以 `error` 结束并带原因码。
- **检索模式**：默认 `hybrid_rerank`；重排失败退回融合顺序，此时 `grade_retrieval` 只看有没有结果，把判断交给生成节点。
- **引用**：只来自本轮检索到的、用户有权看到的块；`n` 与正文里的 `[n]` 对应；答案里引用了不存在的编号会被校验拦下。
- **提示词**：放在文件里，带版本号，写进审计记录的 `details`，方便以后对照。
- **输入防护**（`guard_input`）：空输入、过长（初始上限 2,000 字符）、明显的提示词注入特征（一份简短的规则列表）；这只是第一层，真正的防线是权限在数据库里过滤，模型拿不到无权的内容。

### 计划的命令

```bash
git switch -c m5-agent                      # 已创建
uv sync --all-packages
make migrate                                # 新的迁移 0005
make test && make lint
make up                                     # API 带上新路由
# 真实检查（先打印估算并确认）
uv run python scripts/ask_samples.py        # 约 12 个问题
```

### 验证标准

1. **每个 End 状态都有场景测试**（假的聊天客户端和检索桩）：`answered`、`need_clarification`（含连续 2 次后的 `clarification_limit`）、`no_permission`、`not_found`（检索为空、证据不足、生成返回 `sufficient=false`）、`refused`（越界、输入被拦、写操作、数据查询暂未开放）、`error`（超时、LLM 出错、检索出错、步数超限、校验失败）。
2. **图结构测试**：遍历图的所有边，断言每个节点都能到达某个 End 节点；文档里的流程图由图定义导出，不手工维护。
3. **`finish_run` 的完整性**：任何一次运行（含异常和超时）都写了一行 `ai.runs`（带 `end_state` 和 `end_reason`）、对应的消息和一条 `chat.query` 审计记录；写入在一个事务里，失败时不留半截记录。
4. **API**：会话的创建、列表、读取、改名、归档、发消息、读历史；别人的会话 ID 返回 404；未登录 401；错误格式统一；响应结构与设计 03 一致（`run_id`、`message`、`citations`、`end_state`、`end_reason`）；限流超出返回 429。
5. **权限**：用真实的样例文档（假 embedding 的检索 + 脚本化的聊天模型）：学员问 HR 文件，回答里没有该文档的任何内容、没有引用、`end_state` 是 `no_permission`；HR 问同一问题得到引用；`Admin` 提问得到 `no_permission` / `not_found`，不会读到受限内容；引用只包含用户有权看到的文档。
6. **澄清的两轮**：第一轮含糊的问题得到反问（`need_clarification`），第二轮的补充被合并后得到回答；会话状态在两次请求之间保存在数据库里。
7. **真实检查**（确认费用后）：约 12 个问题真实地问一遍，报告每个的 End 状态、引用、耗时和费用；其中迟交扣分那道（DOC-40）必须算对（先判断落在哪个区间）；`ERR-PORTAL-429` 的回答必须是配额用完，不是设备数量；学员问 HR 文件必须被拒绝且不泄露内容。
8. 本地测试、lint、mypy 通过，CI 通过。

### 开始前不确定的事

- 生成节点的结构化输出（`sufficient`、`answer`、`citations`）在 `gpt-6-luna` 上是否稳定；不稳定时的退路是校验失败重试一次，再失败就 `error`。
- 评分阈值 6 和"不足就重试一次"的效果，需要用评测集和真实检查标定；样本很小，M4 里无答案题的最高分达到过 8。
- LangGraph 1.x 的异步调用、`recursion_limit` 和图导出（用于可达性测试和流程图）的具体接口，开始时对照文档确认。
- 60 秒总超时和每次模型调用 30 秒超时在 `gpt-6-luna` 上够不够；重排平均 2 秒，加上理解和生成，预计总时长 5–8 秒。
- 提示词注入的规则列表只能拦住最明显的写法，不是安全边界；已在上面说明。

### 需要你确认

1. 会话状态存在 `ai.conversations`（迁移 0005），不用 LangGraph 的 checkpointer。
2. `data_query` 暂时以 `not_available_yet` 拒绝。
3. 历史只截断最近 6 轮，不做摘要。
4. 默认模型 `gpt-6-luna`，真实检查时对比 `gpt-6-sol` 再定。
5. 会话标题用第一个问题的前 60 个字符。
6. 限流（每用户每分钟 20 次）一起做。
7. `grade_retrieval` 两道关（重排分数阈值 6 + 生成节点的 `sufficient`）。
8. 真实检查约 12 个问题。

### 用户的确认（2026-11-03）

- 默认聊天模型 `openai/gpt-6-luna`；真实检查时**对比 `gpt-4o-mini`**（不是 `gpt-6-sol`），按结果选默认值。
- 其余 7 条全部接受：会话状态存在 `ai.conversations`（迁移 0005）、不用 LangGraph 的 checkpointer；`data_query` 暂时以 `not_available_yet` 拒绝；历史只截断最近 6 轮；会话标题用第一个问题的前 60 个字符；限流（每用户每分钟 20 次）一起做；`grade_retrieval` 两道关；真实检查约 12 个问题（先估算再确认）。

### 实际结果

**验证标准**（全部满足；本地 437 个测试通过；M4 为 378 个）：

| # | 结果 |
|---|---|
| 1 每个 End 状态都有场景测试 | 在真实数据库上用脚本化的模型和检索替身：`answered`（含问候、答案被拒后重试一次成功）、`need_clarification`（含连续 2 次后的 `clarification_limit`）、`no_permission`、`not_found`（检索为空、证据不足、重试成功、生成返回 `sufficient=false`）、`refused`（越界、写操作、数据查询暂未开放、输入被拦的 4 种情形）、`error`（模型出错、检索出错、生成不是 JSON、答案没有引用或引用不存在的编号、工具出错、调用次数超限、60 秒超时） |
| 2 图结构测试 | 遍历图的所有边：每个节点都能到达某个 End 节点；绘制出的图与文档里列出的路由完全一致；6 个 End 节点正好对应 6 个 End 状态；图可以导出为 mermaid |
| 3 `finish_run` 完整性 | 每次运行（含异常、超时）都写了一行 `ai.runs`、两条消息、一条 `chat.query` 审计记录，并更新会话；写入在同一个事务里，审计写入失败时什么都不留下；出错不会丢失"正在等待澄清"的状态 |
| 4 API | 会话创建、列表（分页、最新在前）、读取、改名、归档（归档后发消息返回 409）、发消息、读历史（分页）；别人的会话返回 404（和不存在一样）；未登录 401；格式错误的 ID 或游标 422；空消息和超长消息 422；响应结构与设计 03 一致；限流超出返回 429 带 `Retry-After`，按用户计数 |
| 5 权限 | 真实的样例文档加真实检索：学员问只有 HR 看得到的问题得到 `no_permission`，回答不含任何内容，模型看到的全部文本里没有 `HR-REC-002`，审计记录了"有被隐藏的内容"（只有数量）；HR 问同一问题得到来自该文档的回答和引用；`Admin`、`RAGETLAdmin` 什么都读不到；5 个业务角色 × 12 个问题的引用和模型看到的片段，全部是该角色有权读的文档 |
| 6 澄清两轮 | 第一轮含糊的问题得到反问，会话状态存在数据库里；第二轮的补充和待澄清的问题合并后得到回答，状态重置；历史也带进了理解步骤 |
| 7 真实检查 | 15 轮、两个版本（见下）；容器冒烟：真实令牌经 HTTP 问 `ERR-PORTAL-429` 得到正确回答并引用 `TS-CRS-005`、问候、历史、他人读取返回 404、Redis 限流 200 / 200 / 429 / 429（按用户分开） |
| 8 工程检查 | lint、mypy 通过；GitHub CI 通过（含全部集成测试，用时约 2 分 38 秒） |

**真实检查结果**（详见 [`docs/eval/README.md`](../eval/README.md)）：

- 第一次运行：默认版本（生成用 `gpt-6-luna`）14/15，`gpt-4o-mini` 11/15。失败暴露了**两个真实的问题**：重排提示词把片段截在 350 token，隐藏了 `ERR-PORTAL-429` 那一行（重排只给 2 分，第一道关拒绝作答）；理解步骤把 Maven 问题当越界。都已修复并加了回归测试。
- 修复后重跑：默认 14/15，`gpt-4o-mini` 12/15。默认版本剩下的一道（DOC-43）是我的判定条件过严，不是助手答错；`gpt-4o-mini` 在迟交扣分题上稳定答错（说得 0 分，答案没有引用标记所以被校验拦下），在 DOC-47 上过于积极地用全员可读的文档作答（没有引用保密文档，不是泄露）。
- **默认模型保持 `gpt-6-luna`。**
- 费用：两次运行合计估算不到 0.06 美元（含第一次因为我的脚本读审计表被拒而中途停止之前已经发出的少量调用）。

**与计划不一致或新增的地方：**

| 项 | 说明 |
|---|---|
| 重排截断 | `rerank_passage_tokens` 默认从 350 改为 600，必须不小于块的上限；这是 M4 的基线没发现的问题，因为基线只看排名，不看绝对分数 |
| 理解提示词 | 版本 2，明确技术支持范围 |
| 隐藏内容阈值 | 初始的 0.3 在实测后改为 0.5：问受限文档的问题得分 0.57–0.74，无答案的问题 0.09–0.41（样本小，间隔窄） |
| `finish_run` 的位置 | 由运行时包装层调用，而不是每个 End 节点（异常和超时也一定会被记录）；已写入设计 04 |
| 问候 | 用固定回复，不调用模型 |
| 流程图 | 图可以导出为 mermaid，但设计 04 里的流程图仍是手写的，还没有改成自动导出 |
| 测试替身 | `ScriptedChat`、`StubRetrieval`、`Harness` 放在 `starit_core/testing.py`，两个测试目录共用；共享的临时数据库夹具移到了 `ai-module/conftest.py` |
| 容器配置 | API 容器现在传入 `OPENAI_API_KEY`、embedding 变量和 `STARIT_RATE_LIMIT_CHAT_PER_MINUTE` |
| 我的一个失误 | 提交回归测试时其中一个测试是失败的（我估错了测试数据的 token 数，而它自己的前置断言抓住了这一点），我提交之后才发现，没有在当时的汇报里说明；已在下一个提交里修正，并让它同时断言旧的 350 上限确实会隐藏那一行 |

**已知限制（诚实记录）：**
- 答案校验只做确定性检查（引用编号存在、有引用、不为空、不超长）。**带着引用的错误答案会通过**（例如把事实说错但仍标了 `[1]`）。让模型核对事实的做法放到评测之后再决定。
- 提示词注入的规则列表只能拦住最明显的写法，不是安全边界；真正的防线是权限在数据库里过滤，模型拿不到无权读的内容。
- 固定回复只有英文；历史只保留最近 6 轮；会话标题是第一个问题的前 60 个字符。
- 真实检查每个场景只问一次，模型每次的回答可能略有不同（理解步骤的分类就曾在两次运行里不一样），样本很小，不能据此断定模型的优劣。
- 隐藏内容的阈值和重排分数的阈值（6）都是在几十道题上标定的，换一批文档或问法可能需要重新标定。
- 数据查询（M6）和写操作确认（第二阶段）尚未实现，以固定的拒绝回答。


---

## M6 数据访问：MCP 与 SQL Agent

状态：**进行中**（分支 `m6-data-access`）。把现在被固定拒绝的"查数据"问题接上：固定的参数化工具（经 MCP）加自由问法的只读 SQL。本里程碑会调用 OpenAI 的聊天模型（选工具、生成 SQL、根据结果作答）。

### 开始前的调研结果（已核对）

| 项 | 结果 |
|---|---|
| MCP SDK | 最新版是 `mcp 2.3.0`，**API 和旧版不同**（`FastMCP` 改名为 `MCPServer`，客户端也变了）。我做了一个小原型验证：`MCPServer(token_verifier=..., auth=AuthSettings(..., validate_token_resource=False))`、工具里用 `get_access_token()` 取到调用者和原始令牌、客户端用 `Client(streamable_http_client(url, http_client=httpx2.AsyncClient(headers={"Authorization": ...})))`。**有效令牌能调用工具；错误令牌和没有令牌都被拒绝（401）** |
| SQL 解析 | `sqlglot 30.27.0`（MIT），按 PostgreSQL 方言解析，能取出表名（含 schema）、CTE、函数、语句条数、语句类型；用来做语句校验 |
| 视图 | `ai_sql` 里 7 个视图：`campuses`、`assignments`、`students`、`submissions`、`support_tickets`、`employees`、`expense_claims`（列见 M2）。行级范围已由视图保证，这是真正的边界 |
| 评测集 | 26 道应回答的题，M2 只核对了 17 道的答案；**其余 9 道（SQL-01、02、04、05、06、08、09、10、13）要由真实生成的查询核对**。其中 SQL-01、02 问"超过 FIN-REIM-002 的酒店限额"，限额（一线城市 600、二线 450）写在政策文件里，**只靠表无法回答，需要把政策片段也给 SQL 生成步骤** |
| 设计 03 的约定 | 工具使用固定的参数化查询；**自由问法的 SQL 由 Agent 内部的只读 SQL 工具处理，不经过 MCP**；工具错误码 `forbidden`、`not_found`、`invalid_argument`、`internal_error`；每次调用写 `mcp.<tool>` 审计 |

### 需要先确认的问题

1. **使用 MCP SDK 2.x**（`MCPServer`），依赖固定为 `mcp>=2.3,<3`。SDK 很新，2.x 的接口以我验证过的为准。
2. **Agent 调用 MCP 工具的方式**：生产环境经 HTTP，**转发用户自己的 JWT**，由 MCP Server 自己校验签名和受众 `starit-mcp`（设计 03 的 6.1）；这需要把原始令牌从 API 一路传给运行时（只留在内存里，不写日志、不写审计）。测试和评测不起 HTTP 服务，使用**进程内实现**（和 MCP 服务端共用同一套工具函数）。
3. **SQL 生成步骤带政策片段**：数据类问题先做一次检索（混合模式、不重排、取前 3 个片段，权限过滤照常）把相关政策放进提示，这样"酒店限额"这类题才答得出来。多一次检索（数据库加一次向量化），不多一次模型调用。
4. **数据类回答的引用**：引用数据来源而不是文档。设计 03 的引用结构新增 `kind` 字段：`"document"`（现有的，补上这个字段）或 `"data"`（带 `views` 和 `row_count`）。回答里仍用 `[n]` 标记，校验照常要求有引用。
5. **超出范围的数据问题怎么拒绝**（评测里 7 道"应拒绝"的题）：视图返回空结果分不清"没有"和"没权限"，所以在执行前加两道**尽力而为的检查**：(a) 角色对这张视图本来就没有访问权（例如学员查员工表、Admin 查任何数据）→ `no_permission / restricted_data`；(b) 查询里 `campus_id` 的字面值不是提问者自己的校区，且角色不是全公司范围（hr、finance）→ 同样结束。这两道检查只能识别写在 SQL 里的字面值，真正的保护仍然是视图。
6. **给 MCP 工具补评测题**：在评测集里新增约 8 道工具类的题（查自己的报销单状态、某门作业有哪些、某个学员的进度等），由样本数据生成器算出答案，因为现有的 33 题几乎都需要聚合，走的是 SQL。
7. **`search_documents` 工具**默认用混合模式、不重排（MCP 服务端不带聊天模型）；需要重排的场景走助手本身。
8. **真实检查**：评测集 33 题加新增的工具题约 41 题，先给调用数和估算费用，确认后运行。

### 计划的文件（`ai-module/` 下，除非另写）

| 文件 | 作用 |
|---|---|
| `packages/core/src/starit_core/dataaccess/sqlguard.py`（新） | SQL 语句校验：单条 `SELECT`/`WITH`、只能访问 `ai_sql` 视图、函数白名单、禁止 `INTO`、加锁、CTE 里的写操作、`pg_*` 等；校验"校区字面值"与提问者校区的一致性 |
| `packages/core/src/starit_core/dataaccess/schema.py`（新） | 视图说明（给 SQL 生成的提示用）、校区代码表、角色对视图的访问表 |
| `packages/core/src/starit_core/dataaccess/tools.py`（新） | 6 个工具的实现（固定的参数化查询，经 `run_as_identity`）、参数校验、错误码、`mcp.<tool>` 审计 |
| `packages/core/src/starit_core/dataaccess/client.py`（新） | `DataTools` 接口；`McpDataTools`（HTTP 调 MCP，转发用户令牌）和 `LocalDataTools`（进程内） |
| `packages/core/src/starit_core/sqlaccess.py`（改） | 支持绑定参数 |
| `packages/core/src/starit_core/agent/nodes.py`、`graph.py`、`state.py`、`messages.py`（改） | 新节点：`plan_data_access`、`call_data_tool`、`run_sql`（生成→校验→执行→重试）、`answer_from_data`；`data_query` 不再以 `not_available_yet` 结束；新增的原因码 `restricted_data`、`no_matching_rows`、`sql_failed`、`tool_error` |
| `packages/core/src/starit_core/agent/prompts/plan_data.md`、`sql.md`、`answer_data.md`（新） | 提示词和版本号 |
| `packages/core/src/starit_core/agent/runtime.py`（改） | 接收用户的原始令牌；构造数据工具 |
| `apps/mcp-server/src/starit_mcp_server/`（改）：`main.py`、`auth.py`、`tools.py` | MCP 服务：`MCPServer`、令牌校验（沿用 `TokenVerifier`，受众 `starit-mcp`）、6 个工具、健康检查 |
| `apps/api/src/starit_api/conversations.py`（改） | 把令牌交给运行时 |
| `deploy/compose/compose.yaml`、`.env.example`（改） | `mcp-server` 服务（端口 8100）；API 依赖它；`STARIT_MCP_URL` |
| `packages/core/src/starit_core/config.py`（改） | `model_plan`、`model_sql`、各项上限（SQL 重试 2 次、工具调用 ≤ 3 次、行数上限、超时）、`mcp_url` |
| `ai-module/sample-data/tools/generate_structured.py`、`eval/sql-qa.jsonl`（改） | 新增约 8 道工具类的题 |
| `eval/src/starit_eval/data_check.py`、`cli.py`（改） | `starit-eval data`：把数据题真实地问一遍并按期望答案核对，写报告 |
| `packages/core/tests/dataaccess/`、`packages/core/tests/integration/test_data_*.py`、`apps/mcp-server/tests/`（新） | 见验证标准 |
| `docs/design/03`、`04`、`ai-module/README.md`（改） | 引用的 `kind` 字段、数据路径、MCP 使用方式 |

### 图的变化（设计 04）

```
understand ── data_query ──▶ plan_data_access ─┬─ 参数化工具 ──▶ call_data_tool ─┐
                                               └─ 自由问法 ───▶ run_sql ────────┤
        结果：无权限（访问表或校区检查） ──▶ END_NO_PERMISSION (restricted_data)
              空结果 ───────────────────▶ END_NOT_FOUND (no_matching_rows)
              校验或执行连续失败 ────────▶ END_ERROR (sql_failed / tool_error)
              有数据 ──────────────────▶ answer_from_data ──▶ verify_answer ──▶ END_ANSWERED
```

`run_sql` 内部：检索政策片段 → 生成 SQL → 校验 → 执行 → 失败时把错误告诉模型再生成，最多重试 2 次。

### 关键设计决定（建议）

- **边界仍是数据库**：模型生成的 SQL 只会在 `ai_sql_ro` 角色下对视图执行，视图只返回该用户有权看到的行；`sqlguard` 是第二层，目的是在到达数据库之前拦下明显有问题的语句，并给出明确的拒绝原因。
- **校验用白名单而不是黑名单**：只允许 `SELECT`（含 `WITH`）；表必须带 `ai_sql.` 前缀且在 7 个视图之内；函数必须在白名单里（计数、求和、平均、最值、`round`、`coalesce`、`nullif`、`lower`、`upper`、日期函数、`cast` 等）。
- **回答只基于结果**：`answer_from_data` 只拿到问题、执行的 SQL（用于说明依据）和结果行；被告知"结果只包含用户有权看到的数据，不要把它说成全公司的总数"。
- **结果行数上限 200、语句超时 5 秒**（沿用 M2 的 `run_as_identity`）；结果很大时只把前几十行交给模型并说明被截断。
- **审计**：每次数据查询写 `data.sql` 或 `mcp.<tool>` 审计（用户、语句或参数摘要、行数），不写结果内容。
- **令牌只在内存里**：不进日志、不进审计、不进错误信息。

### 计划的命令

```bash
git switch -c m6-data-access                      # 已创建
uv sync --all-packages
(cd sample-data && python3 tools/generate_structured.py)   # 新增工具类的题
make test && make lint
make up                                           # 现在包含 mcp-server
make eval ARGS="data --yes"                       # 数据题真实评测（先打印估算并确认）
```

### 验证标准

1. **SQL 校验**：一批（60 条以上）人工构造的语句逐条断言放行或拒绝：合法的聚合、连接、CTE、日期运算放行；多条语句、非 `SELECT`、`biz.*`、`ai.*`、`pg_catalog.*`、`public.*`、不带前缀的表名、`set_config`、`pg_sleep`、`current_setting`、`INTO`、`FOR UPDATE`、CTE 里的 `DELETE` 等全部拒绝，并给出原因。
2. **校区与访问表检查**：校区字面值（`=`、`IN`、别名列）不一致的情形有测试矩阵；**角色对视图的访问表与数据库里的视图行为一致**（对 9 个演示账号 × 7 个视图：访问表说"无权"的，视图一定返回空）。
3. **每个数据路径的结束状态都有测试**（脚本化的模型）：`answered`、`no_permission / restricted_data`、`not_found / no_matching_rows`、SQL 第一次无效第二次修正、连续三次无效 → `error / sql_failed`、数据库超时 → `error / sql_failed`、工具参数错误或工具出错 → `error / tool_error`、调用次数超限 → `step_limit`。
4. **敌意输出的测试**：模型返回 `SELECT * FROM biz.students`、多条语句、`set_config` 等，在到达数据库之前被拦下，没有任何查询被执行。
5. **MCP 服务**：真实启动服务端做集成测试：有效令牌可调用；签名被改、过期、受众只有 `starit-api` 的令牌、没有令牌都被拒绝；6 个工具对演示账号返回与视图一致的数据；`list_students` 对学员只返回自己、对员工只返回本校区；查别人的报销单返回 `not_found`；参数错误返回 `invalid_argument`；每次调用都有 `mcp.<tool>` 审计记录。
6. **图结构**：每个节点仍能到达某个 End 节点；绘制出的图与文档里的路由一致。
7. **真实检查**（确认费用后）：评测集的数据题（26 道应回答的 + 7 道应拒绝的 + 新增的工具题）真实地问一遍，**应回答的按期望答案核对，应拒绝的必须以 `no_permission` 或 `not_found` 结束且不泄露数字**；报告里写明每一道的结果、失败的原因、费用；**不预设通过率**，先看结果再决定怎么调。
8. **容器冒烟**：`mcp-server` 容器健康；经 HTTP 用真实令牌问一个数据题，确认 API → MCP 的令牌转发有效。
9. 本地测试、lint、mypy 通过，CI 通过。

### 开始前不确定的事

- **MCP SDK 2.x 很新**（2.3.0），接口以原型验证的为准，可能还会变；固定版本，并在 README 里写明。
- **模型生成 SQL 的质量**：日期运算（`submitted_date - expense_date`）、"超过 30 天"之类的口径、`CASE` 分档，`gpt-6-luna` 能答对多少我不知道，以真实评测为准；调不好的话退路是改提示词、给更多例子，而不是放宽校验。
- **`sqlglot` 的 PostgreSQL 方言与数据库的实际语义有细微差异**，可能误拒合法语句或漏掉冷僻写法；漏掉的不会造成越权（数据库角色只能读视图），但可能让模型执行到不该执行的函数，所以用函数白名单，并由数据库角色兜底。
- **每次调用 MCP 都新建会话**，会增加一点延迟（预计 100–300 毫秒）；以后可以改成复用连接。
- **把原始令牌传进运行时**会扩大令牌的暴露面，需要保证任何异常信息和日志里都不含令牌（有测试）。
- 校区检查只能识别 SQL 里写明的字面值；用子查询、连接绕过的写法它看不出来，但视图仍然只返回有权看到的行。

### 需要你确认

1. 使用 MCP SDK 2.x（`mcp>=2.3,<3`）。
2. 生产环境 Agent 经 HTTP 调 MCP 并转发用户令牌；测试和评测用进程内实现。
3. SQL 生成步骤带检索到的政策片段（不重排）。
4. 引用结构新增 `kind`（`document` / `data`）。
5. 执行前的两道检查：角色访问表、校区字面值。
6. 评测集新增约 8 道工具类的题。
7. `search_documents` 工具默认混合模式、不重排。
8. 真实检查约 41 题（先估算再确认）。

### 用户的确认（2026-11-03）

8 条全部接受：MCP SDK 2.x（`mcp>=2.3,<3`）；生产环境经 HTTP 调 MCP 并转发用户令牌，测试和评测用进程内实现；SQL 生成步骤带检索到的政策片段（不重排）；引用结构新增 `kind`；执行前的两道检查（角色访问表、校区字面值）；评测集新增约 8 道工具类的题；`search_documents` 默认混合模式不重排；真实检查约 41 题（先估算再确认）。

### 实际结果

**状态：代码完成，真实检查已跑；CI 待检查，待你确认合并。**

- **自动测试**：615 个全部通过（M5 结束时 437 个）。新增：SQL 校验 100 多条语句（放行/拒绝/视图白名单/函数白名单/角色与校区检查）、角色访问表与视图一致性（逐账号）、视图列与结构描述一致性、6 个工具（各角色、越权、参数错误、审计）、真实 MCP 服务（线程中的 uvicorn、真实签名校验；无令牌、乱码、错误密钥、过期、受众不符都得到 401）、Agent 数据路径（工具路径、SQL 路径、重试、拒绝、空结果、令牌不落盘）、评测判分。lint 和 mypy 干净。
- **容器冒烟**：`mcp-server` 容器健康；用 Keycloak 签发的真实令牌调用工具：经理查本校学员成功，查别校（`campus_id=BJ`）得 `forbidden`，学员调用报销工具得 `forbidden`，员工查自己的报销单成功、查别人的得 `not_found`，乱码令牌被拒；`ai.audit_log` 里有对应的 `mcp.*` 记录（含被拒的），容器日志里没有令牌。
- **经 API 容器的整条链路**（真实模型）：问"我的报销单 C0107 状态是什么"，API 把用户令牌转发给 `mcp-server` 容器，工具返回 `paid`，回答带 `kind: "data"` 的引用，审计里有 `mcp.get_expense_claim_status`，容器日志里没有令牌。**这次检查发现了一个真实的缺陷**：SDK 的主机头检查（防 DNS 重绑定）拒绝了 Compose 内的服务名 `mcp-server:8100`，API 得到 `tool_error`。之前的服务测试用 `127.0.0.1` 访问，没覆盖到。已加配置项 `mcp_allowed_hosts`（保持防护开启，只放行列出的主机），并加了两条回归测试（放行服务名、拒绝陌生主机，都带有效令牌，使判定只取决于主机头）。第一次问的"我校区有多少学员"走的是 SQL 路径，答案 5，没有经过 MCP。过程中 Docker 磁盘写满（清理了构建缓存 6 GB 后重建）。
- **真实数据检查**（`starit-eval data`，默认模型 `openai/gpt-6-luna`，41 题）：第一次 39/41，151 次模型调用，约 $0.03（估算 $0.027）。报告：`docs/eval/data-check-20261103-1733.md`。
  - **SQL-26**（学员平均分）：答案正确（81.5000…），是**我的判分太严**——只接受写成 `81.5` 的数字。已改为按数值比较。
  - **SQL-29**（上海经理问北京学员数）：**真实的缺口**。模型写的是 `campuses.name = 'Beijing'` 之类的条件，我的校区检查只认 `campus_id` 的字面值，没拦住，用户得到"0 个学员"。视图没有泄露任何数据，但这不是设计要求的结果（应当拒绝）。已补：语句读取 `campuses` 视图时，字符串里出现别的校区的城市名，同样按 `campus_scope` 拒绝；`expense_claims.city` 是出差城市，不受影响（有测试）。
  - 修复后只重跑这两题：2/2 通过，7 次模型调用，约 $0.001。报告：`docs/eval/data-check-20261103-1737.md`。**41 题没有整体重跑**，所以"41/41"没有在同一次运行里出现过。
- **与设计的差异**：
  - `search_documents` 的 `top_k` 最大 8（设计写 10）；没有 `doc_code` 参数；`domain` 是对 `doc_code` 前缀（HR-/FIN-/TS-）的过滤，在检索之后做；返回的字段里没有 `status`、`page`、`chunk_id`、`score`（只有 `doc_code`、`title`、`version`、`heading_path`、`text`）。Agent 的规划步骤不用这个工具（文档问题走原来的检索路径），它主要给其他 MCP 客户端。
  - 一次运行最多调一个数据工具（清单写的是 ≤3）；工具参数错误时退到 SQL 路径。
  - `agent_max_llm_calls` 从 6 提到 8，容纳 SQL 重试。
  - 未用 `doc_code` 前缀以外的方式给 `Candidate` 加 `domain`。
  - 对 MCP SDK 的 `custom_route` 装饰器加了一处 `type: ignore`（SDK 的类型标注不完整）。
- **已知限制**：校区检查只能识别写在 SQL 里的校区编码或（读 `campuses` 时的）城市名，换一种写法（比如用子查询按别的列间接指向别校）可能漏过去——真正的保护仍是视图，漏过去的结果是"空数据"，不是别校的数据。空结果统一说"没找到匹配记录"，分不清"没有"和"没权限"，这是有意的。SQL 路径的质量取决于模型；41 题里只有这一次拦截缺口，样本小，不能当作基准。

## M7 文档管理与前端

状态：**进行中**（分支 `m7-docs-frontend`）。两件事：(1) 后端的文档管理 API 和"点击引用看原文"的接口；(2) `ai-module/web/` 的 Next.js 前端：登录、聊天页、会话列表、引用查看、文档管理页。本里程碑**不调用付费模型**，只在最后做一次小的真实检查（见下）。

### 开始前的现状（已核对）

| 项 | 结果 |
|---|---|
| 已有的 API | `/healthz`、`/me`、`/conversations` 及其消息接口。路径没有 `/api/v1` 前缀（M5 就是这样做的）。**没有** CORS 配置。**没有**任何 `/documents` 接口 |
| 已有的文档服务（core） | `register_document`、`update_access`、`set_status`、`delete_document`、`set_content`、入库队列、`ObjectStorage`（只有 `put`/`get`，**没有 `delete`**）。上传的路径与 `register_from_manifest` 相同 |
| 引用里缺什么 | 文档类引用有 `doc_code`、`chunk_id`，**没有 `document_id`**，前端点击引用时无法请求 `/documents/{id}/chunks` |
| 前端 | 目录 `ai-module/web/` 还不存在。Node 20.19.6、npm 10.8.2 已装；`.nvmrc` 还没有 |
| Keycloak | `starit-web` 客户端已配好：公开客户端、授权码 + PKCE（S256）、重定向 `http://localhost:3000/*`、Web 源 `http://localhost:3000`、令牌受众含 `starit-api` 和 `starit-mcp` |
| 权限 | `RAGETLAdmin` 的账号只有这一个角色，按设计 01 的 4.3，**只能看文档元数据，看不了正文**；管理接口只允许 `RAGETLAdmin` |
| CI | 目前只有 `ai-module` 一个作业（Python），没有前端作业 |

### 需要先确认的问题

1. **浏览器登录方式**：用 `oidc-client-ts` 在浏览器里做授权码 + PKCE，令牌放在内存（刷新页面时用 `sessionStorage` 恢复），请求 API 时直接带 `Authorization: Bearer`。不做服务端会话、不用 NextAuth。好处是和后端"只信 JWT"的模型完全一致，没有第二套会话；代价是令牌在浏览器里（用 PKCE 和短有效期缓解）。
2. **浏览器怎么访问 API**：API 增加 CORS 中间件，允许的来源由 `STARIT_CORS_ORIGINS` 配置（默认 `http://localhost:3000`），只允许 `Authorization`、`Content-Type` 头，不带 cookie。备选是 Next.js 反向代理，会多一跳，也让 SSE（以后）更麻烦。
3. **路径前缀**：保持已经实现的无前缀路径（`/conversations`、`/documents`……），把设计 03 里的 `/api/v1` 前缀改成"以后需要时再加"。前缀改动会牵动 M5 的全部测试和脚本，价值不大。
4. **文档管理 API 的范围**：设计 03 第 5 节的 7 个端点（`POST/GET /documents`、`GET/PATCH/DELETE /documents/{id}`、`POST …/reindex`、`GET …/jobs`）加阅读用的 `GET /documents/{id}/chunks` 与 `GET /documents/{id}/file`。上传限制：单文件 ≤ 20 MB，只收 docx/pdf/md/txt（按扩展名和文件头双重判断）；相同 `content_hash` 且相同 `(doc_code, version)` 返回 409。`DELETE` 是硬删除（设计已定），所以给 `ObjectStorage` 加 `delete`。所有写动作写审计。
5. **引用加 `document_id`**：文档类引用新增 `document_id`（设计 03 同步修改），前端点击 `[n]` 时请求该文档的分块并高亮被引用的块；数据类引用（`kind: "data"`）只显示视图名和行数，不能点开。
6. **前端技术栈**：Next.js 15（App Router）、TypeScript 严格模式、Tailwind、shadcn/ui、ESLint、Prettier；单元测试用 Vitest + Testing Library；包管理用 npm（`package-lock.json` 入库）；`.nvmrc` 固定 Node 20。
7. **第一阶段不做流式**：聊天页发送后显示"思考中"，等 `POST …/messages` 返回完整回答（实测约 3–8 秒）。设计里的 SSE 属于第二阶段。
8. **端到端冒烟测试（Playwright）**：需要下载 Chromium（约 150–300 MB）——**下载前要你同意**。覆盖：登录、提问、查看引用、上传文档。为了不花钱也不依赖模型，提问这一步**拦截 `POST …/messages` 返回固定回答**；上传这一步走真实的 API → 入库队列 → worker，但容器里的嵌入用 `EMBEDDING_PROVIDER=fake`（M3 已有）。在本地用 `make e2e` 运行（需要 `make up`），**CI 里不跑**（CI 没有完整的 Compose 栈），CI 只跑前端的 lint、类型检查、Vitest 和构建。
9. **容器**：Compose 增加 `web` 服务（Next.js standalone 构建，端口 3000，依赖 api 与 keycloak），`.env.example` 增加 `NEXT_PUBLIC_*` 配置（API 地址、Keycloak 地址与客户端 ID）。
10. **真实检查**：做完后用 `RAGETLAdmin` 账号上传 1 个小文档，用**真实嵌入**入库（估算不到 $0.001），再用一个有权限的账号问一个关于它的问题（约 4 次模型调用，约 $0.001）。先给估算，你确认后再跑。

### 计划的文件（`ai-module/` 下）

| 文件 | 作用 |
|---|---|
| `apps/api/src/starit_api/documents.py`（新） | 文档管理与阅读的 8 个端点；`require_roles("RAGETLAdmin")`；分页（`limit`/`cursor`）、过滤；上传校验 |
| `apps/api/src/starit_api/main.py`、`config`（改） | 挂载路由；CORS（`cors_origins`） |
| `packages/core/src/starit_core/storage.py`（改） | `ObjectStorage.delete`（S3 与内存实现） |
| `packages/core/src/starit_core/documents.py`（改） | 列表查询、读取分块、元数据更新的服务函数（保持"同一事务更新文档和分块"） |
| `packages/core/src/starit_core/agent/nodes.py`（改） | 文档引用带 `document_id` |
| `apps/api/tests/integration/test_documents.py`（新）等 | 见验证标准 |
| `web/`（新） | `app/`（登录回调、聊天页、文档管理页）、`components/`（对话、引用抽屉、会话列表、文档表格与上传表单，shadcn/ui）、`lib/`（OIDC、API 客户端）、`tests/`（Vitest）、`e2e/`（Playwright）、`Dockerfile`、`package.json`、`.nvmrc` |
| `deploy/compose/compose.yaml`、`.env.example`、`Makefile`（改） | `web` 服务；`make web-dev`、`make e2e` |
| `.github/workflows/ci.yml`（改） | 前端作业：`npm ci`、lint、类型检查、Vitest、构建 |
| `docs/design/01`、`03`、`ai-module/README.md`（改） | 路径前缀说明、引用的 `document_id`、前端的启动方式 |

### 页面（第一阶段）

- `/`：已登录进入聊天页；未登录跳转 Keycloak。左侧会话列表（新建、重命名、归档），中间对话，回答里的 `[n]` 是可点击的标记，点击打开右侧抽屉：文档名、编号、版本、状态、章节路径、被引用的块（高亮）和前后块；数据类引用显示"来自数据：students，12 行"。回答的结束状态为 `no_permission`/`not_found`/`refused`/`error` 时显示对应的普通提示（后端已给出统一文案）。
- `/admin/documents`：只有 `RAGETLAdmin` 在菜单里看得到；表格（编号、标题、版本、状态、入库状态、更新时间），过滤；上传表单（设计 03 第 5 节的字段）；行内操作：编辑元数据与权限、重新入库、删除（二次确认）、查看入库任务（阶段、次数、错误码与错误信息）。其他角色直接访问该地址显示"没有权限"，后端同样返回 403。
- 菜单、按钮是否显示只依据 `/me`；后端每个接口都再次校验。

### 计划的命令

```bash
git switch -c m7-docs-frontend                    # 已创建
uv sync --all-packages
(cd web && npm ci)
make test && make lint                            # 后端
(cd web && npm run lint && npm run typecheck && npm test && npm run build)
make up                                           # 现在包含 web
make e2e                                          # Playwright（需先同意下载浏览器）
```

### 验证标准

1. **文档管理 API 的权限矩阵**：9 个演示账号 × 每个端点：只有 `RAGETLAdmin` 成功，其余 403，未登录 401。
2. **上传**：合法的四种格式 202 并入队；超过 20 MB、扩展名与文件头不符、缺必填字段、非法 `access_level` → 422；重复 → 409 并给出已有文档 ID；写审计。
3. **完整流程**（假嵌入）：上传 → worker 入库 → `ingest_status = ready` → 有权限的账号能检索到、无权限的账号检索不到。
4. **元数据与权限修改**：`PATCH` 后文档和所有分块在同一事务里一致（沿用 M2 的测试方式）；状态改为 `superseded`/`archived` 后检索行为符合设计 02。
5. **删除与重新入库**：删除后文档、分块、向量、原文件都没有了，会话历史里的引用文本保留；重新入库成功后原子替换旧分块，失败时旧分块不动。
6. **阅读接口**：`chunks`/`file` 与检索使用同一个权限函数；无权限返回 404；`RAGETLAdmin`（无业务角色）读正文得到 404、读元数据得到 200。
7. **引用**：文档类引用带 `document_id`，用它请求分块能得到被引用的块。
8. **CORS**：允许的来源能通过预检；其他来源不返回 `Access-Control-Allow-Origin`。
9. **前端**：Vitest 覆盖 OIDC 回调与令牌处理、`/me` 驱动的菜单（7 个角色各一个断言）、引用抽屉、上传表单校验、错误状态；lint、类型检查、构建通过。
10. **Playwright 冒烟**（本地）：登录、提问（拦截的回答）、点击引用看到原文、`RAGETLAdmin` 上传到 `ready`；普通账号看不到管理菜单，直接访问管理地址得到无权限页面。
11. **容器冒烟**：`web` 容器健康，浏览器经 `http://localhost:3000` 完成登录和一次提问。
12. 真实检查（确认后）：上传 1 个小文档用真实嵌入入库，再问一个问题得到带引用的回答。
13. 本地测试、lint、mypy 通过，CI（含新的前端作业）通过。

### 开始前不确定的事

- **令牌放在浏览器里**是安全上的取舍（XSS 能读到 `sessionStorage`）。缓解：Keycloak 令牌有效期短（沿用现在的设置）、前端不渲染未经转义的 HTML、回答按纯文本/受控的 Markdown 渲染。若你更想用服务端会话（NextAuth + 后端换令牌），代价是多一套会话，要在第 1 条里改。
- **shadcn/ui、Tailwind、Next.js 15 的最新次版本**我会在开始时核对并固定版本；Next.js 的大版本更新快，可能和我记忆里的 API 有差别，以实际安装的为准。
- **Playwright 在 Mac 上的浏览器下载**需要网络和约 300 MB 磁盘（Docker 磁盘刚刚满过一次，这是本机的实际约束，与浏览器无关，但提醒一下）。
- **上传大文件和入库时长**：docx/pdf 的解析在 worker 里，上传接口只入队；页面靠轮询 `GET /documents`（每 3 秒）更新状态，没有推送。
- **删除是硬删除**，不可恢复；前端用二次确认，后端写审计，但没有"回收站"。

### 需要你确认

1. 浏览器内 OIDC（授权码 + PKCE），令牌在内存/`sessionStorage`。
2. API 加 CORS，来源可配置。
3. 保持无前缀路径，修改设计 03。
4. 文档管理 8 个端点，上传 ≤ 20 MB、四种格式，`ObjectStorage` 加 `delete`。
5. 文档类引用加 `document_id`。
6. 前端栈：Next.js 15、TypeScript 严格、Tailwind、shadcn/ui、Vitest、npm、Node 20。
7. 第一阶段不做流式。
8. Playwright 本地运行、拦截聊天回答、假嵌入上传；**同意下载 Chromium**；CI 只跑 lint/类型/Vitest/构建。
9. Compose 增加 `web` 服务。
10. 真实检查：上传 1 个小文档（真实嵌入，不到 $0.001）+ 1 个问题（约 $0.001），先估算后确认。

### 用户的确认（2026-11-03）

10 条全部接受（浏览器内 OIDC；CORS；无前缀路径；8 个文档端点；引用加 `document_id`；前端栈；不做流式；Playwright 本地运行并**同意下载 Chromium**；Compose 加 `web`；真实检查先估算后确认）。

### 暂停记录（2026-11-04）

用户临时离开，**M7 暂停**，等用户下达"恢复"指令再继续。当时的状态：

- **已完成并提交**（分支 `m7-docs-frontend`）：后端文档管理 API、读取接口、CORS、引用 `document_id`（699 个 Python 测试通过）；Next.js 前端（登录、聊天、引用抽屉、文档管理页，61 个 Vitest 测试，lint、类型、格式、构建通过）；web 的 Dockerfile、Compose `web` 服务、CI 前端作业、Makefile 目标、Playwright 测试、README 和设计 03 的修订。
- **容器**：`api`、`web`、`worker`、`mcp-server` 等都在运行且健康；`web` 返回 200，API 的 CORS 对 `http://localhost:3000` 放行；`worker` 已恢复为正常（`openai`）嵌入配置。
- **没有完成**：(1) Playwright 冒烟测试**一次都没有跑完**——Chromium 下载到约 50% 时被我按暂停指令中止；再跑一遍 `make e2e` 会重新下载（约 186 MB）。(2) 真实检查（上传 1 个小文档 + 1 个问题）还没做，需先给估算并等确认。(3) 本节"实际结果"还没填。(4) CI 还没在新分支上跑过前端作业。(5) 合并和 `ai-m7` 标签。
- **本机环境的发现**（会写进实际结果）：Docker Desktop 的虚拟磁盘曾写满（`no space left on device`），Postgres 因此崩溃并进入恢复模式，`worker` 重启了一个多小时；清理了 6 GB 构建缓存后恢复。镜像构建里下载 Python 依赖的网络很慢，`uv` 默认的 30 秒超时导致失败，已在 `python.Dockerfile` 里设为 `UV_HTTP_TIMEOUT=120`；这次 API 镜像构建用了约 40 分钟。Docker 里还有约 8.6 GB 镜像和 10 GB 卷可回收，未动。
- **未提交的改动**：`ai-module/deploy/docker/python.Dockerfile`（超时设置）和本记录。

恢复后的顺序：确认容器健康 → `make e2e` → 处理失败（如有）→ 填实际结果 → 给真实检查的估算并等确认 → 推送、看 CI → 请用户确认合并并打 `ai-m7`。

### 实际结果

**状态：代码完成，端到端冒烟和真实检查通过，待你确认合并。**

- **后端测试**：699 个通过（M6 结束时 615 个）。新增 82 个文档 API 测试：7 个角色 × 7 个管理端点（只有 `RAGETLAdmin` 成功，其余 403，未登录 401）；上传校验（扩展名与文件头不符、空文件、非 UTF-8 文本、含二进制的文本、超过 20 MB、缺字段、非法 `access_level`/`doc_code`/`version`/`domain`/`status`/`min_level`、路径穿越的文件名）；重复上传 409 且消息带已有文档 ID；**完整流程**（真实 worker、假嵌入）：上传 → `ready` → 员工检索得到、学员和 `RAGETLAdmin` 检索不到；`chunks`/`file` 对员工 200、对学员和 `RAGETLAdmin` 404；`around` 取前后块；`PATCH` 后文档和所有分块的权限在同一事务里一致，改成 `draft` 后读不到；等级要求可设置、可清除；删除后文档、分块、原文件都没有、审计保留、再删 404；重新入库后分块被整体替换、任务历史两条；列表过滤（域、状态、入库状态、标题或编号、`%` 当字面量）与分页；CORS（允许前端来源，不允许其他来源，普通请求也不带 `Access-Control-Allow-Origin`）。
- **前端**：Vitest 61 个通过；lint、类型检查（严格模式，含 `noUncheckedIndexedAccess`）、格式检查、生产构建都干净。覆盖：`[n]` 解析（未知编号保持文本、内容不当作 HTML）、返回路径只接受站内路径、7 个角色的菜单（只有 `RAGETLAdmin` 看到"文档"链接；直接进入管理页也显示无权限且不发请求）、引用抽屉（数据类显示视图与行数；文档类请求 `around`、高亮被引用的块、读取失败或没有 `document_id` 时的提示）、上传表单（校验、不发请求、字段与重复项的编码、服务器错误如重复）、文档页（列表、删除要二次确认、过滤、入库任务与错误原因）、聊天（建会话、发送、显示回答与来源、限流提示）、API 客户端（带令牌、401 触发重新登录、无令牌不发请求）。
- **Playwright 冒烟**（`make e2e`，Chromium，对真实的 Compose 栈）：3 个通过。(1) 员工登录：看得到助手、看不到"文档"、直接进管理页显示无权限、**直接用令牌请求 `/documents` 得到 403**；(2) 提问（模型被拦截为固定回答，页面和 API 是真的）、点击 `[1]` 看到来源；(3) `RAGETLAdmin` 上传文档 → 等到 `ready`（worker 临时用假嵌入）→ 管理员账号读不到正文（404）、员工读得到 → 在聊天页点击引用看到原文 → 管理员在页面里删除（有确认）→ 行消失。`make e2e` 结束后 worker 自动恢复成真实嵌入，数据库里没有残留的测试文档。
- **e2e 的两处是我的测试写错了，不是应用的问题**：Next.js 自带的路由播报元素也是 `role="alert"`，我的定位器匹配到两个；`Title` 同时匹配了标题输入框和"Search title or code"，改成按文字和精确标签定位。
- **容器**：`web`（standalone 构建）、`api`、`mcp-server`、`worker` 等都健康；`web` 返回 200；API 对 `http://localhost:3000` 的 CORS 预检通过。
- **与确认点的差异**：(a) shadcn/ui 的组件（按钮、输入、徽章、对话框等）是我**手写**的，沿用它的工具库（`class-variance-authority`、`clsx`、`tailwind-merge`）和风格，没有用它的 CLI，避免交互式安装和多出来的 Radix 依赖；对话框用 `role="dialog"` 自己实现。(b) 前端用 Next.js 15.5.29 + React 19 + Tailwind 4（npm 上最新是 Next 16，按设计固定在 15）。(c) `min_level` 是 1–7 的等级序号。(d) 列表的 `cursor` 是偏移量，不是游标键。(e) 回答按纯文本渲染（`[n]` 变按钮），不渲染 Markdown。(f) 第 8 条里"上传这一步走假嵌入"是通过 `make e2e` 临时切换 worker 实现的。
- **本机环境的发现**：Docker Desktop 虚拟磁盘曾写满（`no space left on device`），Postgres 崩溃进入恢复模式，`worker` 重启了一个多小时；清理 6 GB 构建缓存后恢复，之后用户把磁盘上限调到 80 GB，又清理了停止的容器、悬空镜像和构建缓存（约 6 GB）。镜像构建里下载 Python 依赖的网络很慢，`uv` 默认的 30 秒超时导致一次构建失败，已在 `python.Dockerfile` 设 `UV_HTTP_TIMEOUT=120`；API 镜像构建用了约 40 分钟。
- **已知限制**：令牌放在浏览器的 `sessionStorage`（XSS 能读到；缓解：Keycloak 令牌有效期短、不渲染 HTML）；`npm audit` 报告 16 条中高危，来自开发工具（Vitest 的依赖、`minimatch`）和 Next.js 自带的 PostCSS（只涉及不可信 CSS 输入，本项目的构建只处理自己的 CSS），**接受，没有强制升级**到会引入 Next 16 的版本；上传后的状态靠每 3 秒轮询，没有推送；删除是硬删除，没有回收站；Playwright 只在本地运行，CI 只跑前端的 lint、类型、格式、Vitest 和构建。
- **真实检查**（用户确认后运行，真实嵌入和真实模型 `openai/gpt-6-luna`）：用 `RAGETLAdmin` 账号经 API 上传一个小文档 `VERIFY-001`（"核查城市的酒店标准是 CNY 777/晚"）→ 状态 `queued → running → ready`；再用员工账号提问"What is the hotel allowance per night for the verification city?"。**第一次助手没有直接回答，而是反问"Which verification city do you mean?"**（`need_clarification`）——是模型对我措辞的判断，不是链路问题；我在同一会话里补一句"The one in the Verification city allowance document."，第二次得到正确回答"CNY 777 per night … need approval from the finance controller [1]"，`end_state = answered`，引用带 `document_id` 和 `chunk_id`，用它请求 `GET /documents/{id}/chunks?around=…` 员工读到被引用的原文，`RAGETLAdmin` 账号读同一个文档得到 404；最后用 `RAGETLAdmin` 删除（204），数据库里文档和分块都是 0，测试文件已清理。**只问了这一个问题（两轮），不是一个题集**，不能当作质量结论；费用按估算不到 $0.002，没有逐项统计。**没有经真实浏览器登录点击这条真实回答的引用**——浏览器里点击引用由 Playwright（回答被固定）覆盖，真实回答的引用只用 API 验证了。
- **未完成**：本分支最新一次推送的 CI 结果。

## M8 完整评测、可观测性与收尾

状态：**已完成，待合并**（分支 `m8-eval-observability`）。第一阶段的最后一个里程碑：把评测补全（更多的题、答案正确性、实验矩阵、一份汇总报告）、给所有服务接上 OpenTelemetry 和 Grafana（Langfuse 可选）、做"一条命令起来、不用 OpenAI 密钥也能有数据"的种子，最后对照设计 06 第 8 节的 7 条逐条验收并打 `v0.1.0`。评测和 LiteLLM 代理的真实检查会花钱，**先估算再等你确认**。

### 开始前的现状（已核对）

| 项 | 结果 |
|---|---|
| 评测 | 已有：检索评测（4 种模式、权限扫描 54 题 × 7 角色）、助手抽查（15 轮）、数据题（41 题，`starit-eval data`）。**没有**：答案正确性评分、拒绝正确性的汇总、运行指标汇总、实验矩阵的其余项、一份把它们合起来的报告。`ai.eval_runs`/`ai.eval_results` 表已有 |
| 评测题 | `qa-set.jsonl` 54 题（`keyword` 3、`version` 2、`paraphrase` 1、`unanswerable` 3，`manager`/`hr` 各 1 题）——设计 05 已指出太少，说好 M8 补充 |
| 派生内容（摘要、假设性问题） | `derive` 阶段在管线里是**空的**（注释写着"评测证明有用再加"），实验矩阵里"派生内容"这一项目前做不了 |
| 可观测性 | **完全没有**：没有 OTel、没有指标、没有 Grafana。日志是 JSON，带 `request_id`，没有 `trace_id` 和 `run_id` |
| 种子 | 没有 `make seed`；现在是 `make seed-biz` + `make ingest-samples`，后者**需要 OpenAI 密钥**。没有预置的向量库转储，也没有 `seed/` 目录 |
| **一个我之前没有记录的偏差** | 设计 01 的 4.2（你已确认）写的是：full profile 经 **LiteLLM 代理服务**调用模型，lite 才用进程内的 litellm 库。**M5 做的是所有 profile 都用进程内的 litellm 库**，Compose 里没有 LiteLLM 服务，`STARIT_LLM_GATEWAY` 这个变量也不存在。这是我在 M5 漏记的偏差，现在补上，第 1 个确认点请你决定 |
| 资源 | Docker Desktop 的内存上限约 11.7 GB，现在 8 个核心服务合计约 2.1 GB（Keycloak 826 MiB、api 331 MiB、worker 279 MiB、对象存储 306 MiB、mcp-server 139 MiB、web 131 MiB、Postgres 89 MiB、Redis 39 MiB）。虚拟磁盘 80 GB |

### 需要先确认的问题

1. **LiteLLM 代理**：补上设计 01 约定的做法——Compose 增加 `litellm` 服务（端口 4100，模型别名和密钥放在它的配置里），api、worker、mcp-server 通过 `STARIT_LLM_GATEWAY=litellm_proxy` 经它调用；在宿主机直接运行（`uv run`、评测）时默认仍用进程内库（`litellm_lib`）。好处：密钥只在一个服务里、调用和费用有统一的记录、与设计一致；代价：多一个服务（预计 0.3–0.5 GB）和一层配置，我**还没核对**当前 LiteLLM 代理镜像的版本和配置格式，开始时先核对。备选：不做，改设计 01，把"full 经代理"改成"所有 profile 进程内"。
2. **评测运行器的完整版**：新增 `starit-eval answers`（对 `qa-set.jsonl` 问助手并打分）：编号、数字、日期等**确定性比对**；其余用 LLM 判官（判官模型单独配置，默认 `gpt-6-luna`），并**随机抽 20% 导出成一张表供人工核对**（判官的结论没有核对前不当作事实）；拒绝正确性（`should_answer=false` 的题：状态合法且回答不含受限事实）；每次运行的 `end_state`/`end_reason` 合法性；延迟 p50/p95、token、估算成本（来自 `ai.runs`——**注意应用账号读不到审计表，但能读 `ai.runs`**，我会先核对）。再加一个 `starit-eval all`，把检索、答案、数据、权限扫描合成**一份报告**，写入 `ai.eval_runs`（含提交号和全部配置）并生成 `docs/eval/` 下的 Markdown。
3. **补充评测题（合成）**：我读样例文档，补写 `keyword`、`version`、`paraphrase`、`unanswerable` 各至少 8 题，`manager`/`hr`/`finance` 提问者至少再 6 题，每个受限文档至少一道"不被允许的角色问它"的题。每题写明来源文档和期望答案，并**用脚本核对期望答案里的事实确实出现在来源文档里**（防止我写错）。题集总数大约从 54 涨到 90 多。样本仍然很小——补完也**不对准确率下结论**，只是让各题型至少有 8 题。
4. **实验矩阵里做哪些**（设计 05 的 4.4）：
   - 检索模式（4 种）：在补充后的题集上重跑——**做**。
   - 分块大小 300 / 500 / 800：重新入库（嵌入费用可以忽略，约 11k token）——**做**。
   - 编号查询的 `identifiers` 加权开/关：加一个配置开关——**做**，不花钱。
   - 派生内容（无 / 摘要 / 假设性问题 / 全部）：要**先实现** `derive` 阶段（入库时每个块多 1–2 次模型调用，28 份文档 39 个块约 80 次调用，约 $0.01），再比较——**建议做**，这是学习"改写问法"最直接的实验；若你想控制范围可以去掉。
   - Rerank 实现（LLM 列表式 / 专用 API）：专用 API 没有接入——**不做**，记录为"只比较了 LLM 列表式"。
   - 关键词排序 `ts_rank_cd` / BM25 扩展：扩展没有安装、没有验证过——**不做**，记录决定"第一阶段不引入 BM25"。
5. **可观测性的范围**：api、worker、mcp-server 接入 OpenTelemetry：HTTP 请求、SQLAlchemy 查询、**每次模型调用**（模型名、token、耗时）、**图的每个节点**、每次工具调用都是 span；日志加 `trace_id`、`run_id`。指标：请求量与延迟、`end_state` 分布、检索延迟、模型调用数与 token、入库队列长度与失败数、被权限过滤的分块比例。Compose 增加 `observability.yaml`（OTel Collector、Prometheus、Grafana、Tempo），Grafana 预置 4 个仪表盘（运行概览、End 状态分布、检索与模型延迟、入库任务）；`make up-obs` 启动。**Loki（日志）这次不做**：日志仍是带 `trace_id` 的 JSON，用 `docker logs` 看，省约 0.5 GB 内存；你若想要，设计 06 里 Loki 本来标的是"视内存"。
6. **Langfuse（可选 Compose 文件）**：`langfuse.yaml`（Langfuse 的 web、worker 和它依赖的 Postgres、ClickHouse、Redis、对象存储），通过 Collector 把**同一份 trace** 用 OTLP 发过去，并把评测分数写到 Langfuse。验收标准 6 要求"Langfuse 和 Grafana 能看到同一次运行"，所以需要它。**我还没核对 Langfuse 当前版本自托管需要哪些服务、OTLP 接入方式和镜像版本**，开始时先核对并实测内存，回填到设计 06（预计比其他可观测性组件重得多，粗估 2 GB 以上，**未核实**）。
7. **种子与 `make seed`**：`make seed` = 导入业务表（`seed-biz`）+ 载入**预置的向量库转储** + 把样例原文件放进对象存储（这样点击引用能打开原文）。转储 `seed/ai-seed.sql.gz` 含文档、分块、向量（`text-embedding-3-small`）、派生内容，**不含**会话、审计、评测记录；由 `make seed-dump` 从验证过的库导出。这样**不需要 OpenAI 密钥就能有一个可用的知识库**（提问仍需要密钥）。`make seed ARGS=--ingest` 走真实的入库管线（需要密钥）。体积预计不到几 MB；超过 GitHub 限制则放发布附件。Keycloak 的 realm 本来就在 `make up` 时导入。
8. **验收**：把设计 06 第 8 节的 7 条逐条跑一遍，写成 `docs/eval/acceptance-v0.1.0.md`（每条的命令、结果、没验证到的部分）。第 1 条"干净的 Mac 上 `make up && make seed`"：我在**这台机器**上执行 `make clean`（**会删除这个项目的本地数据卷**：Postgres、Redis、Keycloak、对象存储里的演示数据，不动别的项目的卷；`.env` 保留）后重新 `make up && make seed`，记录耗时。这不等于一台真正干净的机器，报告里会写明。
9. **标签**：合并后同时打 `ai-m8` 和计划里写的 `v0.1.0`（AI 模块第一阶段）。
10. **真实检查**（先估算再确认）：(a) `starit-eval all`：约 90 道文档题（每题理解 + 重排 + 生成 + 判官约 4 次调用）+ 数据题 41 道（约 4 次/题），估计 500–600 次模型调用，**估算费用我在命令里算出来给你看**，预计在 $0.2 以内；(b) 分块大小、`identifiers`、派生内容的矩阵重跑，主要是检索评测，费用主要是重排；(c) 经 LiteLLM 代理问 1 个真实问题；(d) Langfuse/Grafana 看同一次运行。

### 计划的文件（`ai-module/` 下）

| 文件 | 作用 |
|---|---|
| `eval/src/starit_eval/answers.py`（新）、`judge.py`（新）、`report.py`、`cli.py`、`runner.py`（改） | 答案正确性（确定性 + 判官 + 20% 人工抽查表）、拒绝正确性、运行指标、`starit-eval answers` 与 `all`、汇总报告 |
| `eval/src/starit_eval/matrix.py`（新） | 实验矩阵：重新入库后跑检索评测，保存每个配置的结果 |
| `sample-data/eval/qa-set.jsonl`、`sample-data/tools/`（改） | 补充的评测题与核对来源事实的脚本 |
| `packages/core/src/starit_core/ingest/derive.py`（新）、`pipeline.py`、`config.py`、`retrieval/keyword.py`（改） | 派生内容、`identifiers` 加权开关 |
| `packages/core/src/starit_core/telemetry.py`（新）、`agent/nodes.py`、`llm.py`、`dataaccess/tools.py`、三个服务的入口（改） | OTel 初始化、节点/模型/工具的 span、指标、日志里的 `trace_id`/`run_id` |
| `deploy/compose/observability.yaml`、`langfuse.yaml`、`deploy/observability/`（新） | Collector、Prometheus、Tempo、Grafana（预置数据源与 4 个仪表盘）、Langfuse |
| `deploy/compose/compose.yaml`、`deploy/litellm/config.yaml`（新/改） | LiteLLM 代理服务；`STARIT_LLM_GATEWAY` |
| `packages/core/src/starit_core/llm.py`、`embeddings.py`、`config.py`（改） | 经代理调用（`api_base`），两种网关的切换 |
| `scripts/seed.py`、`scripts/seed_dump.py`、`seed/`（新）、`Makefile`（改） | `make seed`、`make seed-dump`、`make up-obs` |
| 相应的测试 | 见验证标准 |
| `docs/design/01`、`04`、`05`、`06`、`ai-module/README.md`、`docs/eval/README.md`、`docs/eval/acceptance-v0.1.0.md`（改/新） | 偏差与实测的回填、使用文档、验收报告 |

### 计划的命令

```bash
git switch -c m8-eval-observability                 # 已创建
uv sync --all-packages
make test && make lint && make web-check
make up                                             # 现在含 litellm
make up-obs                                         # Collector、Prometheus、Tempo、Grafana
make seed-dump && make clean && make up && make seed   # 种子的往返验证（会删本项目的数据卷，先确认）
make eval ARGS="all"                                # 先打印估算并等确认
make eval ARGS="matrix"                             # 先估算并等确认
```

### 验证标准

1. **答案评分**：确定性比对（数字、编号、日期、金额、带逗号的数）有单元测试；判官用假模型测试它的解析和失败处理；20% 抽查表可重现（同一随机种子）；拒绝正确性的判定有测试（含"回答里带受限事实就算失败"）。
2. **新增评测题**：脚本核对每题的期望答案事实都在来源文档里；各题型数量达标；每个受限文档至少有一道被禁角色的题；**权限扫描（54 → 全部题 × 7 角色 × 3 种模式）越权为 0**。
3. **派生内容与加权开关**：`derive` 的单元测试（假模型）；开关关闭时 `identifiers` 加权确实不起作用（有测试）；重新入库后原子替换。
4. **OTel**：测试里用内存导出器，断言一次对话产生的 span 有预期的层次（HTTP → 图节点 → 模型调用/检索/工具 → 数据库）、同一个 `trace_id`；数据类问题经 MCP 时 trace 跨服务连起来；日志带 `trace_id` 和 `run_id`；**span 属性和日志里没有令牌、没有问题原文以外的个人数据**（有测试：令牌、`Authorization` 头不出现在任何 span 或日志里）。
5. **指标**：测试用内存读取器断言 `end_state` 计数、模型调用数、token、入库队列长度等指标被记录。
6. **Compose**：`make up-obs` 后 Collector、Prometheus、Tempo、Grafana 健康；Grafana 里 4 个仪表盘存在且查询有数据（跑几次真实或假模型的对话之后）；Prometheus 能查到 `end_state` 指标；Tempo 里能按 `run_id` 找到 trace。
7. **Langfuse**：`langfuse.yaml` 启动后，同一次运行的 trace 在 Langfuse 和 Grafana（Tempo）里都能找到；实测内存回填设计 06。
8. **LiteLLM 代理**：容器健康；经代理问一个真实问题得到带引用的回答；代理不可用时 API 的错误处理走 `error` 终态且不泄露密钥；密钥不出现在 api/worker/mcp-server 的环境变量里（只在 `litellm` 服务里）。
9. **种子**：`seed-dump` → 清空 → `seed` 的往返：文档数、分块数、向量数、`content_hash` 一致；**不用 OpenAI 密钥**的 `make seed` 之后，无权限账号仍检索不到受限文档（权限回归）；点击引用能打开原文（对象存储里有文件）。
10. **完整评测与矩阵**（确认费用后）：`starit-eval all` 出报告并写 `ai.eval_runs`；矩阵的每个配置都有结果；报告里写清楚样本量和局限，**不事先承诺任何指标数值**。
11. **验收报告**：设计 06 第 8 节的 7 条逐条有命令、结果、没验证到的部分。
12. 本地测试、lint、mypy、前端检查通过，CI 通过。

### 开始前不确定的事

- **OpenTelemetry、Prometheus、Grafana、Tempo、Langfuse、LiteLLM 代理这几个组件的当前版本、镜像名和配置格式我都还没核对**（它们更新很快，我的记忆可能过时）；实现前先逐个核对并固定版本，核对不了的写在记录里。
- **Langfuse 的资源**：它依赖的服务多（含 ClickHouse），在 11.7 GB 的 Docker 内存里和其余服务一起跑不一定宽裕；实测后再决定是否默认启用，验收时可能需要先停掉别的可选组件。
- **LiteLLM 代理本身的稳定性和对 `gpt-6-luna` 等模型名的支持**：如果代理对某个模型别名不认，要在它的配置里补，可能影响重排/理解步骤的 JSON 模式。
- **判官（LLM 评分）会有误判**；20% 抽查只能估计误判率，不能消除；样本小，报告里不会写"准确率 X%"这样的结论，只写通过多少题和哪几题没过。
- **派生内容**可能没有明显收益，也可能让检索变差（假设性问题会引入噪声）；这是实验，结果可能是"不建议开启"。
- **`make clean` 后重新 `make up && make seed`** 的耗时主要取决于镜像是否已在本机；这台机器上镜像都已存在，比真正的新机器快得多，报告会写明。
- **任务量很大**：评测、OTel、三个可选 Compose 文件、代理、种子、验收报告。如果中途发现范围太大，我会先停下来问你要不要把 Langfuse 或派生内容拆到 M8 之后，而不是悄悄缩水。

### 需要你确认

1. 补上 LiteLLM 代理（full 经代理，宿主机运行仍用进程内库）——并承认这是我在 M5 漏记的偏差。
2. 评测运行器的完整版：答案评分（确定性 + 判官 + 20% 人工抽查表）、拒绝正确性、运行指标、`starit-eval all` 汇总报告。
3. 合成补充评测题（各题型 ≥ 8，manager/hr/finance ≥ 6，每个受限文档 ≥ 1 道被禁角色的题），脚本核对来源事实。
4. 实验矩阵：检索模式、分块大小 300/500/800、`identifiers` 加权开关、派生内容（先实现）；不做专用重排 API 和 BM25，并记录决定。
5. 可观测性范围：OTel 贯穿 api、worker、mcp-server；指标；Collector、Prometheus、Tempo、Grafana（4 个仪表盘）；**不做 Loki**。
6. Langfuse 作为可选 Compose 文件，接同一份 trace 和评测分数，先核对版本并实测内存。
7. `make seed` 用预置的向量库转储（不需要 OpenAI 密钥）加原文件上传；`make seed ARGS=--ingest` 走真实管线。
8. 验收：7 条逐条跑并写 `acceptance-v0.1.0.md`；第 1 条在这台机器上 `make clean` 后重来（**会删除本项目的本地数据卷**）。
9. 合并后同时打 `ai-m8` 和 `v0.1.0`。
10. 真实检查：`starit-eval all`、矩阵重跑、经代理问 1 个问题；每项先估算后确认。

### 实际结果

**状态：代码、评测、验收完成；待你确认合并并打 `ai-m8` 和 `v0.1.0`。**

- **做了什么**（对应 10 个确认点）：(1) LiteLLM 代理补上（`ghcr.io/berriai/litellm:v1.106.6`，端口 4100；供应商密钥只在 `litellm` 容器里，api、worker、mcp-server 的环境里没有；用一个真实问题验证——代理处理了 3 次对话调用和 1 次向量化，全是 200）；(2)(3) 评测运行器完整版和 60 道新题；(4) 实验矩阵（检索模式、分块 300/500/800、`identifiers` 开关、派生内容）；(5) OpenTelemetry + Collector + Tempo + Prometheus + Grafana（4 个仪表盘），没做 Loki；(6) Langfuse 可选 Compose；(7) `make seed` 与预置转储；(8) 验收；(9)(10) 见下。
- **测试**：793 个 Python 测试通过（M7 结束时 699 个）、61 个前端测试、3 个浏览器测试；lint、mypy 严格、前端检查都干净；CI 成功。新增的测试覆盖：网关（直连和经代理的参数、密钥不进 repr 和错误信息）、派生内容（模式、失败只丢派生内容、嵌入文本、入库流程）、`identifiers` 开关、答案评分（事实比对含千分位和 `v` 前缀、拒绝、判官解析、合法的结束状态、20% 抽样可重现）、实验矩阵（临时数据库，跑完不留库）、OTel（span 层次、令牌和问题文本不出现在任何 span/事件/指标、错误标记、日志里的 trace_id 和 run_id、跨 HTTP 到 MCP 的 trace、数据库语句不带参数值、API 的 HTTP span、健康检查不入 trace）、种子转储的往返（内容、权限、向量、派生内容一致，残缺转储被拒绝且不动现有数据，恢复后受限文档仍受限）。
- **完整评测**（真实，约 $0.25 的估算）：权限回归通过（2,394 次检索越权为 0）；检索 hit@1 keyword 0.862、vector 0.885、hybrid 0.943、hybrid_rerank 1.0；答案 99/114（15 题逐条读过，**无权限泄露**：8 题回答正确但漏了次要细节被判官判错、4 题过度反问澄清、1 题是我的评分脚本的错、2 题应拒绝却回答了——其中 DOC-108 没有泄露，DOC-90 是有歧义的题）；数据题 41/41。详见 `docs/eval/README.md`。
- **实验矩阵**（真实，约 $0.02）：同一配置两次入库之间 hybrid 的 MRR 就差约 0.01，小于 0.02 的差别不当作效果；分块越小越好的方向（vector hit@1 300 时 0.954 对 baseline 0.885）；`identifiers` 加权对 keyword 型问题有真实的帮助（MRR 1.0 对 0.923，13 题），保持开启；派生内容整体没有明显收益，默认保持关闭，改写型问题值得在更多题上再测。
- **验收**：见 `docs/eval/acceptance-v0.1.0.md`（7 条逐条，附"没验证到的"）。从 `make clean` 到可以提问约 3 分钟（镜像已在本机）。
- **与确认点的差异**：(a) 种子转储是 `jsonl.gz` 而不是 SQL 文件（不依赖 `pg_dump`；设计 06 第 11 节）；(b) 派生内容只加强向量一侧；(c) Langfuse 4 的"events_only"模式下旧的 trace 接口不可用，读数据用 Observations API v2；(d) 评测里 `Question` 新增可选字段 `facts`；(e) `matrix` 用 `DELETE` 而不是 `TRUNCATE` 清库（应用角色没有 TRUNCATE 权限，这是对的）。
- **过程中发现并修好的问题**：(1) **我之前漏记的偏差**——设计里 full profile 经 LiteLLM 代理，M5 起一直是进程内库，现在补上；(2) Python 镜像每改一行代码都要重新下载全部依赖（一次构建约 40 分钟，`uv` 默认 30 秒的下载超时还会让它失败），已把依赖单独成层、加 uv 缓存挂载和 `UV_HTTP_TIMEOUT=120`；(3) `opentelemetry-instrumentation-sqlalchemy` 因 SQLAlchemy 2.1 超出它声明的范围而静默地不记录任何数据库 span（日志里只有一条 ERROR）——用 `skip_dep_check` 并加测试证明；(4) 提交时 gitleaks 拦下了我预先算好的 base64 凭据，改成 Collector 的 `basicauth` 扩展现场编码；(5) 我自己的评分脚本不认 `v2.1` 里的 `2.1`，已修，报告里的数字是修之前的，没有改；(6) 我在 shell 里用 `path` 做循环变量，zsh 里它和 `PATH` 绑在一起，把命令查找弄坏了一次。
- **已知限制**：见验收报告末尾。**20% 人工抽查还没做**，所以判官的结论不能当作事实。

## M9 第二阶段第一批：流式输出、限流补全、模型 fallback、M8 收尾

状态：**待确认**（分支 `m9-streaming-and-limits`）。这一批把你对 `架构图对照验收表` 的决定落地：M8 的尾巴收口、流式输出（先流出，校验不通过时撤回）、限流补成三维、LiteLLM 的多模型 fallback（gpt-6-luna → gpt-4o-mini → Claude Haiku 5.5）。Memory 和写操作确认按你的决定不做（等企业后台）。成本统计按你的决定不做，见下面的核实。会有少量真实模型调用，**先估算再等你确认**。

### 你的 7 条决定（原样记录）

1. M8 的尾巴要做：20% 人工抽查、`understand` 过度反问和"没答案仍标已回答"、Anthropic 与 fallback 验证。
2. 流式输出要做；成本统计 Langfuse 已经有，先不做。
3. Memory、写操作确认先不做，等企业后台有了再做。
4. 流式采用"先流出，校验不通过时撤回"。
5. 图上有、需求清单里没有的（输出端护栏、Jailbreak 检测、MCP Resources 等）先列入第二阶段。
6. 限流（3 维）要做，把缺的两维补上。
7. LiteLLM 多模型 fallback 要做：先 OpenAI 的 gpt-6-luna，再 GPT-4 mini，然后 Claude 最便宜的 Haiku 5.5。

### 我先核实的（只读，没花钱）

| 项 | 结果 |
|---|---|
| 成本统计 | 你说得对：Langfuse 已经按我们的模型名算出了成本。实测一次生成调用：输入 2,803 token、输出 59 token，成本 0.00031 美元，单价输入 1e-7、输出 5e-7，与我们 `pricing.py` 里的 gpt-6-luna 一致；同一对话的调用共享 `sessionId`，可以按会话汇总。**限制**：Langfuse 只在 full profile 里（"仅本地"），做 lite 时这件事要重新决定。 |
| 模型名 | LiteLLM 的价格表里有 `gpt-4o-mini`（输入 1.5e-7、输出 6e-7）和 `claude-haiku-5-5`（输入 1e-7、输出 5e-7，与 gpt-6-luna 相同）。经网关的名字是 `anthropic/claude-haiku-5-5`。你写的"GPT-4 mini"我按 M5 里一直用的 `openai/gpt-4o-mini` 理解——**请确认**。`.env` 里有 Anthropic 密钥，**但它是否有效我没验证过**。 |
| fallback 的实现位置 | LiteLLM 的 `acompletion` 和网关请求都接受 `fallbacks` 参数，所以不必重做网关配置：聊天客户端在直连和经网关两种模式下都传同一个 `fallbacks` 列表（新设置 `STARIT_LLM_FALLBACKS`）。通配路由 `openai/*`、`anthropic/*` 继续有效。Embedding 不做 fallback。 |

### 要先告诉你的几件事（做起来比看上去麻烦或需要你定的）

1. **流式输出比看上去麻烦**。现在 `generate` 输出的是一段 JSON：`{"sufficient": ..., "answer": "...", "citations": [...]}`。流出来的字符是 JSON，不是回答文字，要在收的过程中解析，把 `answer` 字符串的内容（含转义）边解析边发出去。可行：约定键的顺序是 `sufficient` 在前，`sufficient` 为 false 时一个字也不流出；模型不守顺序时退回"整段收完再发"，不会出错。
2. **流式不会让总时间变短，只改善"等第一个字"**。一次运行 p50 约 5.5 秒，前面是理解、检索、重排，只有最后的生成能流式。预计首字在 3.5–4 秒，而不是 5.5 秒。我会加一个"首字延迟"指标把真实数字量出来，不预先承诺。
3. **撤回的体验**。校验不通过时（引用了不存在的摘录、不是合法 JSON 等）用户已经看到了前面的字；撤回是发一个事件，页面把这段字清掉并显示"重新生成中…"，再流出第二次的结果。这是你选的方案，我实现它；**撤回应该很少触发**（我没有统计过，评测里没有一次因它而 `error`），触发时用户会看到一次"回退"。
4. **限流"3 维"图上没写是哪三维，需要你定**。我的建议：① 每用户每分钟（已有，20 次）；② 每 IP 每分钟（例如 60 次，防止一个来源开很多账号）；③ 全站每日 token 预算（防止费用失控，设计 06 里 `STARIT_DAILY_LLM_BUDGET` 就是这个意思）。注意：**本机 Docker 里所有浏览器请求在 API 眼里都来自同一个网关 IP**（`172.25.0.1`），所以 IP 这一维在本机基本等于"全站每分钟"，只有放到真正的反向代理后面并配置可信代理（`X-Forwarded-For`）才有意义；我会做成配置并写清楚。备选的第 ② 维：每用户每天的消息数。
5. **20% 人工抽查需要你本人**：114 题的 20% 是 **23 条**，每条是问题、参考答案、助手的回答和判官的结论，你判"对 / 错 / 说不好"，约 20–30 分钟。我会做一个可以直接点选的网页（和对照表一样），你点完，我读结果、算判官和你的一致率。如果这个环境里页面保存不了你的选择，就退化成"你把结果复制回来"。
6. **`understand`/`generate` 的提示词要改**，改完要重跑评测才知道好没好：`understand` 版本 2 → 3（只在确实缺少关键信息、且没有可用的通用答案时才反问；"哪一年"这类不问），`generate` 版本 1 → 2（材料里没有被问的内容时必须 `sufficient: false`，即使有相关内容）。重跑 `starit-eval answers`（114 题，约 $0.13）和助手抽查（约 $0.01），**先打印估算再等你确认**。验收要看：4 道被反问的题改为直接回答；DOC-108 变成拒绝状态；"How much can I claim?" 这类真正含糊的题仍然反问；权限回归越权仍是 0；通过数不下降（M8 基线 99/114，其中 1 题是评分脚本的错，修后 100/114）。
7. **fallback 之后"哪个模型答的"要看得见**：现在 span 和指标里记的是请求的模型名；fallback 后要记实际答题的模型，并加一个 `starit.llm.fallbacks` 计数和 span 属性，否则 Grafana 里看不出主模型挂了。fallback 只在**报错**时触发（供应商错误、超时、限流、模型不存在），不在"回答质量差"或"JSON 不合法"时触发。
8. **换成 Haiku 之后行为会不一样**（JSON 的写法、遵守"键的顺序"的程度、重排打分）。我建议用 Haiku 做主模型把 114 题跑一遍，知道它作为兜底靠不靠得住，约 $0.13；**可选**，放在确认点里问你。
9. **第 5 条"先列入第二阶段"我这次只记录、不实现**：写进新文档 `docs/design/09-phase2-plan.md`（决定、范围、顺序，列出每一项和它在图上的位置）。你点名的三项是输出端护栏（PII 脱敏、敏感词）、Jailbreak 检测、MCP Resources；"等"字我理解为图上其余"没规划"的项也列为**候选（未排期）**：Analytics Agent、Web Search Agent、Local vLLM、Redis 的缓存与黑名单、Vault 与 Sentry、边缘反向代理与 WAF、PITR 备份。**请确认这个范围。**

### 计划的文件（`ai-module/` 下，除非另写）

| 文件 | 作用 |
|---|---|
| `docs/design/09-phase2-plan.md`（新）、`07`（改） | 第二阶段规划：你的决定、已排期的、候选的、明确不做的 |
| `packages/core/src/starit_core/streaming.py`（新） | 增量解析：从流出的 JSON 里取出 `answer` 的文字（处理转义、跨块切分、键顺序） |
| `packages/core/src/starit_core/llm.py`（改） | `stream()`：litellm `stream=True` 和 token 用量；`fallbacks` 参数；记录实际答题的模型 |
| `packages/core/src/starit_core/agent/nodes.py`、`runtime.py`、`state.py`、`prompts/*.md`（改） | `generate` 和 `answer_from_data` 流式；`verify_answer` 失败时发撤回；`understand` 3、`generate` 2 |
| `apps/api/src/starit_api/conversations.py`、`deps.py`、`main.py`（改） | `Accept: text/event-stream` 时返回 SSE（`run.started`、`message.delta`、`message.retract`、`citations`、`run.ended`，每 15 秒一个保活注释）；不带该请求头时行为不变（评测、脚本、测试照旧）；三维限流 |
| `packages/core/src/starit_core/ratelimit.py`、`config.py`（改） | 每 IP、全站每日 token 预算；`STARIT_RATE_LIMIT_IP_PER_MINUTE`、`STARIT_DAILY_TOKEN_BUDGET`、`STARIT_TRUSTED_PROXIES` |
| `packages/core/src/starit_core/telemetry.py`（改） | `starit.llm.time_to_first_token`、`starit.llm.fallbacks`、`starit.rate_limited` |
| `web/src/lib/sse.ts`、`web/src/components/chat.tsx`（改） | 用 `fetch` + `ReadableStream`（`EventSource` 不能带 `Authorization` 头）；逐字显示、撤回提示、引用在结束时出现 |
| `eval/`（改） | 评测仍走非流式路径；加"流式与非流式的最终内容一致"的检查；review 页面的生成脚本和一致率计算 |
| `deploy/compose/compose.yaml`、`.env.example`（改） | `STARIT_LLM_FALLBACKS`、限流相关变量 |
| 各层测试；`docs/design/03`、`04`、`README`（改） | 事件格式加 `message.retract`；流式在图里的位置 |

### 计划的命令

```bash
git switch -c m9-streaming-and-limits              # 已创建
uv sync --all-packages
make test && make lint && make web-check
make up
make eval ARGS="answers"                           # 提示词改动后重跑（先打印估算并确认）
make e2e                                           # 流式在真浏览器里的冒烟
```

### 验证标准

1. **增量解析**：几十种切分方式（在转义、`\uXXXX`、多字节字符中间切开；`sufficient` 为 false；键顺序颠倒；不合法的 JSON；超长回答）逐一断言：流出的文字拼起来等于最终的 `answer`；`sufficient: false` 时没有任何文字流出；键顺序颠倒时退回整段发送。
2. **流式运行**（脚本化模型，真实数据库）：事件顺序 `run.started` → `message.delta`×N → `citations` → `run.ended`；最终内容与非流式路径完全一致；校验失败时先 `message.retract` 再重新流出；重试用尽时撤回后以 `error` 结束；澄清、拒绝、闲聊、数据路径各有一个场景。
3. **断线**：客户端中途断开，运行在服务端继续跑完，`ai.runs`、`ai.messages`、审计记录完整（测试断言）。
4. **API**：带 `Accept: text/event-stream` 得到 SSE，不带得到和现在一样的 JSON；未登录 401；限流 429 在流开始**之前**返回（是普通 HTTP 响应，不是事件）；令牌不出现在任何事件和日志里。
5. **三维限流**：每个维度各有测试（超限、窗口过去后恢复、Redis 不可用时放行并告警）；IP 维度在没配置可信代理时用对端地址、配置后用 `X-Forwarded-For` 的最后一个可信跳，**伪造的头不起作用**（测试）；每日预算按运行结束时的实际 token 累加，超出时新请求得 429 并带到次日零点的 `Retry-After`。
6. **fallback**：单元测试（主模型报错 → 第二个 → 第三个；三个都失败 → `llm_error`；非错误情况不触发）；**真实检查**（先估算）：把主模型临时设成不存在的名字，确认回答来自 `gpt-4o-mini`；再把前两个都设成不存在，确认回答来自 Haiku 5.5；span 和指标里记的是实际答题的模型。
7. **提示词改动的评测**：见上面第 6 点的 5 项验收；报告写清楚前后对比和样本量，**不事先承诺通过数**。
8. **20% 人工抽查**：23 条全部有你的判断；报告里写判官与你的一致率和不一致的是哪几条，**一致率低就说明判官不可信**。
9. **前端**：Vitest 覆盖 SSE 解析（跨块的事件、保活注释、撤回、`run.ended` 里的最终内容兜底）和撤回时的界面；Playwright 用拦截的 SSE 响应走一遍提问、撤回、引用；真实浏览器里用真实模型问一次，看逐字出现。
10. 本地测试、lint、mypy、前端检查通过，CI 通过。

### 开始前不确定的事

- **LiteLLM 网关转发流式 + `response_format: json_object`** 对 gpt-6-luna 是否一切正常，我没试过；先用一次真实调用验证（不到 $0.001）。
- **`stream_options: include_usage`** 经网关是否能拿到最终的 token 用量；拿不到的话流式运行的 token 统计会缺，我会退回到用估算并明确标出。
- **`fallbacks` 参数经网关传递**，在通配路由（`openai/*`）下的实际行为我还没验证；验证不通过的话改用网关的 `router_settings.fallbacks` 并为三个模型各建一个具名条目（这会改变模型名的约定，到时再告诉你）。
- **Haiku 对 JSON 模式、`reasoning_effort` 的处理**：LiteLLM 会转换或丢弃不支持的参数（`drop_params: true`），但转换后的行为没验证。
- **撤回的前端体验**需要真实用一用才知道合不合适；做完我会用真浏览器看一次，但"合不合适"是你的判断。
- **IP 限流在本机几乎没有意义**（见上），验收时只能用测试证明逻辑，不能在真实多来源下证明。

### 需要你确认

1. 模型链：`openai/gpt-6-luna` → `openai/gpt-4o-mini`（你写的"GPT-4 mini"）→ `anthropic/claude-haiku-5-5`；Anthropic 密钥是否有效由真实检查来验证。
2. 限流三维：每用户每分钟（已有）、每 IP 每分钟（建议 60）、全站每日 token 预算（数值你定，或我先给个保守默认）——或者把第 ② 维换成"每用户每天消息数"。
3. 流式：先流出、校验不通过时撤回；`answer_from_data`（数据路径）也流式；澄清、拒绝、闲聊的固定文案作为一个 `message.delta` 发出，保持前端逻辑统一；本期**不做**"停止生成"按钮。
4. 成本统计不做，用 Langfuse（full profile 里有；lite 没有）。
5. 提示词改动（`understand` 3、`generate` 2）并重跑评测，先估算后确认。
6. 20% 人工抽查：我做点选页面，你花 20–30 分钟判 23 条。
7. 第二阶段规划文档的范围（上面第 9 点：你点名的三项 + 其余候选）。
8. 是否用 Haiku 做主模型把 114 题跑一遍（约 $0.13，可选）。

### 实际结果

（完成后填写）
