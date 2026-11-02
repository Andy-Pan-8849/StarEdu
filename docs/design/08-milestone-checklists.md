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
| 验证标准 4 | 本地 43 个测试全部通过（含集成）；CI 结果见推送后的记录 |
| 验证标准 5 | 已回填到设计文档 06 的 2.2 节（Keycloak 约 650–675 MiB，启动约 10 秒） |
| **与计划不一致** | 命令参数名由 `USER` 改为 `ACCOUNT`（`USER` 会和系统环境变量混淆） |
| **与计划不一致** | 没有开启"非托管属性"，而是在用户属性配置里显式声明 `campus_id`、`level`，更明确 |
| **新增（计划外）** | `starit_api/errors.py` 和 `deps.py`：统一错误格式、`get_identity`、`require_roles`；取不到公钥时返回 503；`pyproject.toml` 里对 FastAPI 的 `Depends` 放宽了 ruff 的 B008 |
| 开始前不确定的事 | Keycloak 26.8.1 的 realm 导入一次成功；健康检查用管理端口 9000 加 bash 的 `/dev/tcp`，有效；`make up` 现在多等约 10–30 秒 |
| 镜像版本 | `quay.io/keycloak/keycloak:26.8.1` |
