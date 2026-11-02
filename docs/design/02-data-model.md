# 设计文档 02：数据模型与权限元数据（AI 模块，第一阶段）

状态：**已获用户批准（2026-11-02），第 8 节 6 个确认点全部接受。** 其余设计文档批准前不写应用代码，也不建表。
依赖：[01 总体架构](01-architecture-and-repo.md)。标记约定同 01：**【已定】**、**【建议】**、**【待定】**。

## 1. 总原则

1. **权限和版本信息跟着分块走**：每个分块保存自己能被谁看到、属于哪个版本，检索时在同一张表里过滤，不做多表 join。
2. **权限由代码强制**：所有检索 SQL 都通过 `core` 里的同一个函数生成，函数必须接收用户身份，没有"不带身份的检索"入口。
3. **入库时把权限展开成明确的集合**（如 `allowed_roles`），查询时只做集合运算，不在查询里算角色继承。
4. **Keycloak 是用户和角色的唯一来源**：AI 侧不建用户表，只存 Keycloak 的用户 ID（`sub`）。
5. AI 侧的表放在 Postgres 的 `ai` schema，业务样例数据放在 `biz` schema，SQL Agent 用只读账号访问（见第 5 节）。迁移用 Alembic。

## 2. 文档与分块

### 2.1 `ai.documents`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `doc_code` | text | 业务编号，如 `FIN-PAY-004`；来自 `manifest.csv` 的 `doc_id` |
| `title` | text | |
| `domain` | text | `hr` / `finance` / `support` |
| `version` | text | 如 `4.0` |
| `status` | text | `active` / `superseded` / `draft` |
| `effective_date` | date | |
| `access_level` | text | 原始访问等级，如 `hr-only`（见 2.3），仅用于展示和重新展开 |
| `allowed_roles` | text[] | 展开后的角色集合 |
| `allowed_users` | text[] | 按人点名（Keycloak `sub`），默认空 |
| `campus_scope` | text[] | `{all}` 或校区编号列表 |
| `min_level` | text | 可选，职级下限（如 `M2`），默认空 |
| `object_key` | text | 对象存储中的原文件 |
| `format` | text | docx / pdf / md / txt |
| `content_hash` | text | SHA-256，用于判断重复上传和变更 |
| `ingest_status` | text | `queued` / `running` / `ready` / `failed` |
| `uploaded_by` | text | Keycloak `sub` |
| `created_at`、`updated_at` | timestamptz | |
| `supersedes_id` | uuid null | 指向被它取代的旧版本 |

唯一约束：`(doc_code, version)`。

### 2.2 `ai.document_chunks`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `document_id` | uuid FK | |
| `chunk_index` | int | |
| `text` | text | 原文，**始终保留** |
| `heading_path` | text[] | 标题路径 |
| `page` | int null | |
| `token_count` | int | |
| `identifiers` | text[] | 从文本中用规则抽出的编号（如 `ERR-PORTAL-403`），用于精确匹配加权 |
| `tsv` | tsvector | 由 `text` 生成（含 `identifiers`），GIN 索引 |
| `allowed_roles`、`allowed_users`、`campus_scope`、`min_level` | 同上 | **从文档复制（反规范化）** |
| `status`、`effective_date`、`doc_code`、`version` | 同上 | 从文档复制，便于过滤和标注 |

一致性规则：文档的权限、状态、版本只能通过 `core` 里的一个服务函数修改，该函数在**同一事务里**更新文档行和它的所有分块，禁止直接 SQL 修改其中之一。

### 2.3 访问等级到角色的展开表【已定，来自评测集的访问模型】

`manifest.csv` 的 `access` 在入库时展开为 `allowed_roles`：

| `access` | 展开后的 `allowed_roles` |
|---|---|
| `students-and-staff` | student、staff、manager、hr、finance |
| `all-staff` | staff、manager、hr、finance |
| `staff` | staff、manager、hr、finance |
| `managers` | manager、hr、finance |
| `finance-and-hr` | hr、finance |
| `hr-only` | hr |

- `Admin`、`RAGETLAdmin` **不在任何展开结果里**（最小权限，见 01 的 4.3）。
- 映射保存在配置文件里。映射变化时，需要一个"重新展开"任务更新文档和分块。

### 2.4 `ai.chunk_embeddings`

| 列 | 类型 | 说明 |
|---|---|---|
| `chunk_id` | uuid PK FK | |
| `model` | text | 如 `text-embedding-3-small` |
| `dimensions` | int | |
| `embedding` | vector(1536) | |

- 向量列的维度在建表时固定。换成不同维度的模型，需要新迁移建新表并重新入库；`model` 和 `dimensions` 每行都记录，用于发现混用。
- **ANN 索引**：样例规模（几百到几千个分块）下，第一版**不建 HNSW**，使用带过滤条件的精确扫描，结果最准确。需要时再加 HNSW，并实测"过滤后结果变少"的问题（pgvector 较新版本提供迭代扫描，需要核对当前版本和行为）【待定】。

### 2.5 `ai.chunk_derived`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `chunk_id` | uuid FK | |
| `kind` | text | `summary` / `question` / `keyword` |
| `text` | text | |
| `tsv` | tsvector | |

- 派生内容是**额外的字段**，不替换原文（RAGFlow 里发现摘要会替换全文索引，我们不这样做）。
- 检索时，原文命中权重最高，派生内容作补充；权限从所属分块继承（查询时 join，派生内容本身不存权限列）。

### 2.6 `ai.ingestion_jobs`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `document_id` | uuid FK | |
| `status` | text | `queued` / `running` / `succeeded` / `failed` |
| `stage` | text | `parse` / `chunk` / `derive` / `embed` / `write` |
| `attempt`、`max_attempts` | int | |
| `run_after` | timestamptz | 重试的最早时间 |
| `locked_by`、`locked_at` | text / timestamptz | worker 领取标记（`FOR UPDATE SKIP LOCKED`） |
| `config` | jsonb | 解析器、分块参数、是否生成派生内容 |
| `error_code`、`error_message` | text | 失败原因，文档管理页展示 |
| `started_at`、`finished_at` | timestamptz | |

## 3. 会话、运行与审计

### 3.1 `ai.conversations`

`id`、`user_id`（Keycloak `sub`）、`title`、`created_at`、`updated_at`、`archived`。会话由用户创建，不自动过期【已定】。

### 3.2 `ai.messages`

`id`、`conversation_id`、`run_id`、`role`（user / assistant）、`content`、`citations`（jsonb：文档、分块、页码、版本）、`created_at`。

### 3.3 `ai.runs`（每次图运行一行）

| 列 | 说明 |
|---|---|
| `id`、`conversation_id`、`user_id` | |
| `started_at`、`ended_at` | |
| `end_state`、`end_reason` | 显式 End 状态和原因码（`answered` / `need_clarification` / `no_permission` / `not_found` / `refused` / `error`，详见文档 04） |
| `model`、`tokens_in`、`tokens_out`、`latency_ms` | 第二阶段的成本统计从这里汇总 |
| `trace_id` | 对应 Langfuse / OTel 的 trace |

LangGraph 的检查点表由其官方 Postgres checkpointer 自己创建（`ai` schema 下），会话状态（`answering` / `need_clarification`）保存在图状态里。

### 3.4 `ai.audit_log`（只追加）

`id`、`ts`、`user_id`、`roles`（jsonb）、`action`（`chat.query` / `doc.upload` / `doc.delete` / `doc.reindex` / `access.denied` 等）、`run_id`、`query_text`、`doc_ids`（本次命中或操作的文档）、`filtered_count`（被权限过滤掉的分块数，**只记数量，不记内容**）、`ip`。

- 应用账号只有 INSERT 权限，没有 UPDATE / DELETE。
- 查询原文是否保存、保存多久，涉及隐私，演示项目先保存，真实环境需要策略【待定】。

## 4. 检索的权限过滤条件【建议】

`core` 里构造的过滤条件（所有检索共用）：

```sql
status IN ('active', 'superseded')          -- 默认包含旧版本，结果中标注状态
AND ( allowed_roles && :user_roles
      OR :user_id = ANY(allowed_users) )     -- 授权：OR
AND ( campus_scope = '{all}' OR :campus_id = ANY(campus_scope) )   -- 强制约束：AND
AND ( min_level IS NULL OR :user_level >= min_level )              -- 强制约束：AND
```

- 与需求文档第六轮的判定规则一致：授权之间 OR，强制约束 AND；显式拒绝（如账号停用）在认证层处理，被拒绝的用户拿不到有效 JWT。
- **旧版本默认参与检索，但带 `status` 标注**：评测集里有"旧政策是什么、现在用哪个"的问题，两个版本都需要被看到；生成阶段的规则是优先引用 `active` 并说明旧版本已被取代。
- 过滤必须在排序之前（过滤条件放进全文检索和向量检索的 `WHERE`）。
- `min_level` 的比较需要把职级（`M1`…`M3`、`S1`…等）映射成可比较的整数，规则放配置里【待定，需对照 `employees.csv` 的 `level` 取值】。

## 5. SQL Agent 的数据访问【建议】

数据位置：样例的 7 张 CSV 导入 `biz` schema，作为业务模块完成前的种子数据；以后由业务模块的真实表替代，AI 侧只改视图定义。

访问方式：

1. 专用数据库账号 `ai_sql_ro`：只读，只能访问 `ai_sql` schema 里的**白名单视图**，不能访问 `biz` 里的原表，也不能访问 `ai` schema。
2. 每次查询在事务里设置 `SET LOCAL app.user_id / app.roles / app.campus_id`，视图通过这些变量实现行级过滤（Postgres 行级安全 RLS 或视图内的 `WHERE`）。
3. 限制：只允许单条 `SELECT`、设置语句超时和最大返回行数。
4. 表和行的可见性（初稿，需对照 `sql-qa.jsonl` 的 `access` 字段核对）：

| 视图 | 可见范围 |
|---|---|
| `campuses`、`assignments` | 所有已登录用户 |
| `employees` | hr、finance 全部；manager 本校区；staff 仅本人 |
| `expense_claims` | hr、finance 全部；manager 本校区；staff 仅本人提交的 |
| `students` | hr 全部；staff、manager 本校区；student 仅本人 |
| `submissions` | student 仅本人；staff、manager 本校区的学员 |
| `support_tickets` | student 仅本人提出的；staff、manager 本校区 |

MCP 的"课程与学员数据（只读）"和"报销状态"两个工具，复用同一组视图和同一套会话变量。

## 6. 评测相关表（第一阶段）

- `ai.eval_runs`：`id`、`started_at`、`git_sha`、`config`（jsonb：检索方式、模型、是否 Rerank）、`summary`（jsonb：总体准确率、权限回归通过率）。
- `ai.eval_results`：`run_id`、`question_id`、`role`、`answer`、`passed`、`retrieved_doc_ids`、`latency_ms`、`notes`。

评测用的测试账号（每个角色至少一个，加上北京 staff、上海 staff、上海 manager）在 Keycloak 里预置，不放进 `ai` 表。

## 7. 索引与迁移摘要【建议】

- `document_chunks`：`tsv` 用 GIN；`allowed_roles`、`campus_scope` 用 GIN；`document_id` 普通索引。
- `chunk_embeddings`：第一版不建 ANN 索引（见 2.4）。
- `ingestion_jobs`：`(status, run_after)` 用于领取任务。
- `audit_log`：`(user_id, ts)`、`(action, ts)`。
- 全文检索的语言配置：英文数据先用 `english`；编号类词项的分词行为（如 `ERR-PORTAL-403` 是否被拆开）**需要实测**，所以保留 `identifiers` 列作为精确匹配的保底。中文数据时再引入分词方案【待定】。
- 迁移：Alembic，`ai` schema；`biz` 种子数据由导入脚本创建，不放进 Alembic 主线。

## 8. 需要你确认的点

1. 权限和版本字段**复制到分块**（反规范化），用服务函数保证一致，是否接受？
2. 展开表（2.3）和"`Admin`、`RAGETLAdmin` 不在任何展开结果里"，是否接受？
3. 旧版本**默认参与检索并标注状态**，是否接受？
4. 第一版**不建 ANN 索引**，用精确扫描，是否接受？
5. SQL Agent 的 5 节方案（白名单视图 + 会话变量行级过滤）和可见范围初稿，是否接受？
6. `ai.audit_log` 保存查询原文，是否接受？

## 9. 确认结果（2026-11-02）

6 个确认点全部接受：权限与版本字段复制到分块；展开表且管理角色不在展开结果里；旧版本默认参与检索并标注；第一版不建 ANN 索引；SQL Agent 用白名单视图 + 会话变量行级过滤；审计日志保存查询原文。
