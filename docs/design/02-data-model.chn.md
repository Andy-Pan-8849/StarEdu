# 设计文档 02：数据模型与权限元数据（AI 模块，第一阶段）

状态：**已获用户批准（2026-11-02），第 8 节 6 个确认点全部接受。** 其余设计文档批准前不写应用代码，也不建表。
依赖：[01 总体架构](01-architecture-and-repo.chn.md)。标记约定同 01：**【已定】**、**【建议】**、**【待定】**。

## 1. 总原则

1. **权限和版本信息跟着分块走**：每个分块保存自己能被谁看到、属于哪个版本，检索时在同一张表里过滤，不做多表 join。
2. **权限由代码强制**：所有检索 SQL 都通过 `core` 里的同一个函数生成，函数必须接收用户身份，没有"不带身份的检索"入口。
3. **入库时把权限展开成明确的集合**（如 `allowed_roles`），查询时只做集合运算，不在查询里算角色继承。
4. **Keycloak 是用户和角色的唯一来源**：AI 侧不建用户表，只存 Keycloak 的用户 ID（`sub`）。
5. AI 侧的表放在 Postgres 的 `ai` schema，业务样例数据放在 `biz` schema，SQL Agent 通过 `ai_sql` schema 里的白名单视图访问（见第 5 节）。迁移用 Alembic。
6. **数据库账号分三个**【M2 修订，已定】：`starit`（库所有者，只用于迁移）、`ai_app`（应用账号，普通权限；审计表只有 INSERT）、`ai_sql_ro`（只读，**不能登录**，应用在事务里用 `SET LOCAL ROLE ai_sql_ro` 切换过去执行 SQL Agent 的查询）。应用不再使用超级用户连接，否则授权和只追加的审计都会失效。
7. **两类访问控制**【M2 修订，已定】：**政策文件**全公司一份，只按**角色**控制（访问等级，见 2.3），与校区无关；**结构化数据和校区资料**（学员名单、工单、提交记录、报销单，以及以后的课件、讲义）按**数据范围**控制：全公司 / 本校区 / 仅本人。这与企业后台常见的"数据权限"一致。

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
| `min_level_rank` | smallint | 可选，最低职级档（1–7，见第 4 节的对照表），默认空 |
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
| `allowed_roles`、`allowed_users`、`campus_scope`、`min_level_rank` | 同上 | **从文档复制（反规范化）** |
| `status`、`effective_date`、`doc_code`、`version` | 同上 | 从文档复制，便于过滤和标注 |

一致性规则：文档的权限、状态、版本只能通过 `core` 里的一个服务函数修改，该函数在**同一事务里**更新文档行和它的所有分块，禁止直接 SQL 修改其中之一。另有一个**一致性检查视图** `ai.v_chunk_permission_drift`，列出权限、状态、版本与所属文档不一致的分块；测试和 CI 断言它为空。

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

## 4. 检索的权限过滤条件【M2 修订】

`core` 里构造的过滤条件（所有检索共用）：

```sql
status IN ('active', 'superseded')          -- 默认包含旧版本，结果中标注状态
AND ( allowed_roles && :user_roles
      OR :user_id = ANY(allowed_users) )     -- 授权：OR
AND ( campus_scope = '{all}'
      OR :campus_id = ANY(campus_scope)
      OR :all_campuses )                     -- 强制约束：AND（数据范围）
AND ( min_level_rank IS NULL
      OR :user_level_rank >= min_level_rank ) -- 强制约束：AND（职级档）
```

- 与需求文档第六轮的判定规则一致：授权之间 OR，强制约束 AND；显式拒绝（如账号停用）在认证层处理，被拒绝的用户拿不到有效 JWT。
- `:all_campuses` 为真表示该用户的角色拥有"全公司"数据范围（`hr`、`finance`，总部职能，配置项 `COMPANY_WIDE_ROLES`）。政策文件的 `campus_scope` 都是 `{all}`，所以它只影响校区资料。
- **旧版本默认参与检索，但带 `status` 标注**：评测集里有"旧政策是什么、现在用哪个"的问题，两个版本都需要被看到；生成阶段的规则是优先引用 `active` 并说明旧版本已被取代。
- 过滤必须在排序之前（过滤条件放进全文检索和向量检索的 `WHERE`）。

### 职级档对照表【已定，2026-11-02】

职级由字母（序列）和数字组成：**I** = 讲师序列（Instructor），**S** = 职能序列（Staff），**M** = 管理序列（Management）。三个序列不能直接比较，所以映射到统一的"档"（1–7）；文档规则写成"第 N 档及以上"。

| 档 | 职级 |
|---|---|
| 1 | S1、I1 |
| 2 | S2、I2 |
| 3 | S3、I3 |
| 4 | I4 |
| 5 | I5 |
| 6 | M2 |
| 7 | M3 |

这是演示项目的约定，真实公司有自己的对标表。对照表放配置里，并写在 `ai-module/sample-data/README.md`。样例文档目前都没有职级限制，所以先预留并用合成数据测试。

## 5. SQL Agent 的数据访问【M2 修订】

数据位置：样例的 7 张 CSV 导入 `biz` schema，作为业务模块完成前的种子数据；以后由业务模块的真实表替代，AI 侧只改视图定义。

访问方式：

1. **账号与切换**：应用以 `ai_app` 连接；执行 SQL Agent 的查询时，在一个事务里先设置身份会话变量（`app.user_id`、`app.roles`、`app.campus_id`、`app.subject_id`），再 `SET LOCAL ROLE ai_sql_ro`，然后才执行查询。`ai_sql_ro` 不能登录，只能读 `ai_sql` schema 的**白名单视图**，没有 `biz` 原表和 `ai` schema 的任何权限。
2. **防篡改**：被执行的 SQL 不能改自己的身份。办法是撤销 `set_config` 对 `PUBLIC` 的执行权限，只授予 `ai_app`；`ai_sql_ro` 无法调用它。M2 有测试证明，M6 还会在应用层增加语句校验（只允许单条 `SELECT`、只访问白名单视图、函数白名单）。
3. **行级过滤用视图里的 `WHERE`**（读会话变量），不使用 Postgres 的 RLS【已定】。以后需要更强保证时，可以在原表上再加 RLS 作为第二道保险。
4. 其他限制：语句超时、最大返回行数。
5. 没有设置身份变量时，所有视图返回空。

视图的可见范围【已定，数据范围；与评测集一致】：

| 视图 | student | staff | manager | hr、finance | Admin、RAGETLAdmin |
|---|---|---|---|---|---|
| `campuses`、`assignments` | 全部 | 全部 | 全部 | 全部 | 全部 |
| `students`、`submissions`、`support_tickets` | 仅本人 | 本校区 | 本校区 | 全公司 | 无 |
| `employees`、`expense_claims` | 无 | 仅本人 | 本校区 | 全公司 | 无 |

一张工单属于**开单人所在的校区**。"本人"通过令牌里的 `student_id` / `employee_id` 判断。

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

## 10. M2 修订记录（2026-11-02）

用户确认：数据库三个账号；"员工只看本校区"针对结构化数据和校区资料，政策文件全公司一份、只按角色控制，`hr`、`finance` 为全公司数据范围；职级档对照表（1–7）；行级过滤用视图 `WHERE`。样本数据和评测集已据此修订（M2.0）。

## 11. M2 实现记录（2026-11-02）

- 迁移：0002（数据库角色、知识库表）、0003（会话、运行、审计、评测表、一致性检查视图）、0004（`biz` 表、`ai_auth` 辅助函数、`ai_sql` 视图、`set_config` 限制）。角色是**整个数据库集群共享**的，所以降级只移除本库的授权，不删除角色；再次升级会复用。
- `tsv` 做成生成列：`array_to_string` 只是 STABLE，被 Postgres 拒绝，所以用一个声明为 IMMUTABLE 的包装函数 `ai.text_array_join` 解决。
- 视图调用的 `ai_auth` 辅助函数以调用者的权限执行，所以 `ai_sql_ro` 需要它们的 `USAGE` / `EXECUTE`；它们只读取调用者自己的身份设置，开放它们不会泄露任何信息。
- 视图使用 `security_barrier`，防止查询中的函数在过滤之前读到行。
- 身份通过五个会话设置传递：`app.user_id`、`app.roles`、`app.campus_id`、`app.employee_id`、`app.student_id`。
- 已知限制：自定义配置项（`app.*`）无法用权限禁止 `SET` 语句。当前的防线是：`set_config` 只授予 `ai_app`；执行入口只接受单条 `SELECT`（拒绝多语句和 `SET`）。语句校验（视图和函数白名单）在 M6 加入。
