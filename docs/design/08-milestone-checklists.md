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

状态：**清单待用户确认**（分支 `m2-data-permissions`）。这是整个项目最关键的安全基础，不需要 OpenAI 密钥。

### 开始前发现的问题（需要先确认，确认后再改设计文档，然后写代码）

1. **数据库账号**：现在应用用 Postgres 超级用户 `starit` 连接，超级用户会绕过所有授权，"审计表只能追加""只读账号"都会失效。M2 起改为三个账号：
   - `starit`（库所有者，只用于迁移）；
   - `ai_app`（应用账号，普通权限；审计表只有 INSERT）；
   - `ai_sql_ro`（只读，**不能登录**，应用在事务里用 `SET LOCAL ROLE ai_sql_ro` 切换过去执行 SQL Agent 的查询）。
2. **SQL 评测题与设计 02 第 5 节的行级规则不一致**：评测集里的 SQL 题都是对**全公司数据**的统计（如 SQL-12"有多少次迟交"、SQL-11"学生和员工各开了多少工单"，访问等级为 `staff`；SQL-15"员工总数"，访问等级为 `finance-and-hr`），而 02 写的是员工只能看本校区。**建议**把规则对齐评测集：

   | 视图 | 可见范围（建议，替代 02 第 5 节的表） |
   |---|---|
   | `campuses`、`assignments` | 所有已登录用户 |
   | `students`、`submissions`、`support_tickets` | 所有员工角色看全部行；学员只看自己的 |
   | `employees`、`expense_claims` | `hr`、`finance` 看全部；`manager` 看本校区；`staff` 只看自己的；学员无权 |

3. **谁是"本人"**：令牌里还没有员工编号或学员编号，没法做"只看自己的"。M2 给 realm 的用户增加 `employee_id` / `student_id` 属性，令牌携带，并让演示账号对应 CSV 里真实的人。样例里 HR、财务、IT 的员工都在成都校区，所以 4 个账号要**改名**，使校区和数据一致：

   | 账号 | 对应 | 校区、级别 |
   |---|---|---|
   | `student.sh`（不变） | 学员 S0018 | SH |
   | `staff.bj`（不变） | 员工 E0014 | BJ，S2 |
   | `staff.sh`（不变） | 员工 E0025 | SH，I2 |
   | `manager.sh`（不变） | 员工 E0018，校区主任 | SH，M3 |
   | `hr.bj` → **`hr.cd`** | 员工 E0137，HR | CD，S3 |
   | `finance.bj` → **`finance.cd`** | 员工 E0138，财务主管 | CD，M2 |
   | `admin.bj` → **`admin.cd`** | 员工 E0140，IT 支持 | CD，S2 |
   | `ragetl.bj` → **`ragetl.cd`** | 员工 E0141，教务办 | CD，I5 |

   这会修改 M1 的 realm、测试和 README。
4. **`min_level` 怎么比较**：职级有三个序列（I1–I5、S1–S3、M2–M3），不能直接比大小。建议把 02 里的 `min_level text` 改成整数 `min_level_rank`，用一张演示用的对照表：S1、I1 = 1；S2、I2 = 2；S3、I3 = 3；M2、I4 = 4；M3、I5 = 5（大致相当于资历档位）。样例文档目前都没有职级限制，所以只是预留并测试。
5. **SQL 查询的身份变量不能被查询自己篡改**：身份用数据库会话变量传给视图，如果被执行的 SQL 能调用 `set_config` 就能改成 `hr`。办法：撤销 `set_config` 对 `PUBLIC` 的执行权限，只给 `ai_app`；执行 SQL 时切换到 `ai_sql_ro`，它没有这个权限。M2 要有测试证明这条防线有效（M6 还会在应用层再加语句校验）。
6. **行级过滤的实现方式**：用视图里的 `WHERE`（读会话变量），不用 Postgres 的 RLS；`ai_sql_ro` 不授予 `biz` 原表的任何权限，只能读 `ai_sql` 视图。更简单，也好测试。

### 要先修改的设计文档（先改文档，再写代码）

| 文档 | 修改 |
|---|---|
| 02 | 1 节：三个数据库账号；2.1/2.2：`min_level_rank`；第 5 节：视图可见范围按上表改，加入 `SET LOCAL ROLE` 和撤销 `set_config` 的说明；新增"一致性检查视图" |
| 01 | 4.3：令牌增加 `employee_id` / `student_id`；演示账号改名 |
| 03 | `/me` 的返回增加 `employee_id`、`student_id` |

### 计划的文件（`ai-module/` 下，除非另写）

| 文件 | 作用 |
|---|---|
| `migrations/versions/0002_knowledge_tables.py` | `ai.documents`、`document_chunks`（含 `tsv`、`identifiers`、反规范化的权限字段）、`chunk_embeddings`、`chunk_derived`、`ingestion_jobs`，及索引（02 第 7 节） |
| `migrations/versions/0003_conversation_audit_eval.py` | `ai.conversations`、`messages`、`runs`、`audit_log`、`eval_runs`、`eval_results`；创建 `ai_app` 账号；授权（`audit_log` 只 INSERT）；一致性检查视图 |
| `migrations/versions/0004_biz_and_sql_views.py` | `biz` 的 7 张表；`ai_sql` 的白名单视图；`ai_sql_ro` 角色（不能登录）及授权；撤销 `set_config` 的 `PUBLIC` 执行权限 |
| `packages/core/src/starit_core/permissions.py` | 访问等级展开表、职级对照表、**统一的检索权限过滤函数**（用 SQLAlchemy 表达式，不拼字符串） |
| `packages/core/src/starit_core/documents.py` | 文档服务：登记文档、修改权限或状态时**同一事务**更新文档和全部分块，并写审计 |
| `packages/core/src/starit_core/audit.py` | 写审计记录 |
| `packages/core/src/starit_core/sqlaccess.py` | 在事务里设置身份变量并 `SET LOCAL ROLE ai_sql_ro` 的辅助函数 |
| `packages/core/src/starit_core/auth.py`（改） | `Identity` 增加 `employee_id`、`student_id` |
| `packages/core/src/starit_core/config.py`（改） | 增加 `migration_database_url`、应用账号密码 |
| `migrations/env.py`（改） | 迁移用 `migration_database_url`（库所有者） |
| `scripts/seed_biz.py`（新）、`Makefile`（改：`seed-biz`） | 把 `sample-data/structured/*.csv` 导入 `biz` |
| `deploy/compose/compose.yaml`、`.env.example`（改） | api 用 `ai_app` 连接；增加迁移连接和应用账号密码变量 |
| `deploy/compose/keycloak/starit-realm.json`（改） | 新属性 `employee_id` / `student_id`，账号改名与映射 |
| `apps/api/tests/integration/test_keycloak.py`、`README.md`（改） | 账号改名后的测试与文档 |
| `packages/core/tests/test_permissions.py`（新，单元） | 展开表与 `manifest.csv` 逐行对照；职级对照 |
| `packages/core/tests/integration/`（新，需要数据库） | 权限矩阵、文档服务、审计、视图、安全防线的测试，见下 |
| `docs/design/02`、`01`、`03`、`08`（改） | 如上，以及完成后的"实际结果" |

### 计划的命令

```bash
git switch -c m2-data-permissions        # 已创建
make up && make migrate                  # 迁移现在以库所有者身份运行
make seed-biz                            # 导入 biz 数据
make test                                # 含集成测试
make lint
```

### 验证标准

1. **迁移**：在全新数据库上从头升级成功；降级再升级也成功。
2. **展开表**：`manifest.csv` 的 28 行逐行展开后，等于评测集的访问模型（单元测试）。
3. **权限矩阵（差分测试）**：往数据库写入覆盖各访问等级、校区范围、`allowed_users`、职级、状态的分块，对 7 个角色 × 多个校区 × 多个职级，**用独立写的 Python 判定与 SQL 过滤函数的结果比对，必须完全一致**。
4. **最小权限**：`Admin`、`RAGETLAdmin`（没有其他业务角色）查不到任何文档分块；没有角色或只有未知角色的身份，什么也查不到。
5. **文档服务**：修改权限或状态后，文档和所有分块在同一事务里一致；中途抛异常整体回滚；一致性检查视图为空。
6. **审计**：`ai_app` 能插入审计记录，**不能 UPDATE 或 DELETE**（权限被拒绝）。
7. **SQL 视图**：对每种身份，各视图返回的行数与用 CSV 独立计算的预期一致；`ai_sql_ro` 读不到 `biz` 原表和 `ai` 的任何表；没有身份变量时视图返回空。
8. **防篡改**：以 `ai_sql_ro` 身份执行 `SELECT set_config('app.roles','hr',true)` 被权限拒绝；`SET LOCAL ROLE ai_sql_ro` 的流程可用。
9. M1 的集成测试在账号改名和新增属性后仍通过；CI 通过。

### 开始前不确定的事

- `tsv` 做成生成列时，Postgres 要求表达式是 immutable，`array_to_string` 可能不满足；若被拒绝，改用触发器维护 `tsv`。
- 在 `pg_catalog` 里撤销系统函数的执行权限，需要确认在这个版本的 pgvector 镜像里可行，并且不会影响 Alembic 或应用的正常使用（测试里验证）。
- Alembic 在迁移里读取环境变量创建 `ai_app` 的密码，需要确认写法在本地和 CI 都可用。
- `ai_app` 作为非超级用户后，`/healthz` 和 M1 的测试是否需要调整授权。

### 需要你确认

1. 三个数据库账号（`starit` 所有者、`ai_app` 应用、`ai_sql_ro` 只读且不能登录）。
2. 视图可见范围按上面"建议"的表对齐评测集（而不是 02 原来的"员工只看本校区"）。
3. 4 个账号改名（`hr.cd`、`finance.cd`、`admin.cd`、`ragetl.cd`）并映射到真实员工。
4. 职级用整数对照表 `min_level_rank`（S1、I1=1，S2、I2=2，S3、I3=3，M2、I4=4，M3、I5=5）。
5. 行级过滤用视图 `WHERE`，不用 RLS。

### 实际结果

（完成后填写）
