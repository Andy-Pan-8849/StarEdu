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

状态：**进行中**（分支 `m2-data-permissions`）。M2.0（样本数据与评测集修订）已完成，其余待用户确认后开始写代码。这是整个项目最关键的安全基础，不需要 OpenAI 密钥。

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

（完成后填写）
