# 设计文档 03：API 与 MCP 契约（AI 模块，第一阶段）

状态：**已获用户批准（2026-11-02），第 8 节 7 个确认点全部接受。** 其余设计文档批准前不写应用代码。
注：文档 04 新增 End 状态 `refused`，本文中 `end_state` 的取值相应增加该项。
依赖：[01 总体架构](01-architecture-and-repo.chn.md)、[02 数据模型](02-data-model.chn.md)。标记约定：**【已定】**、**【建议】**、**【待定】**。

## 1. 通用约定【建议】

- 路径**没有**前缀（M7 修订：M5 起就是 `/conversations`、`/documents`……，需要版本化时再加 `/api/v1`）；JSON；时间用 ISO 8601（UTC）；ID 用 uuid（业务编号如 `doc_code` 单独字段）。
- **认证**：`Authorization: Bearer <JWT>`，由 Keycloak 签发，api 用 JWKS 校验；身份只来自 JWT，请求体里的任何 `user`、`role` 字段一律忽略。
- **统一错误格式**：

```json
{ "error": { "code": "forbidden", "message": "…", "request_id": "…" } }
```

| HTTP | `code` | 场景 |
|---|---|---|
| 401 | `unauthenticated` | 无 JWT、过期或签名无效 |
| 403 | `forbidden` | 已登录，但角色不允许调用该接口 |
| 404 | `not_found` | 资源不存在，**或用户无权看到它**（不泄露存在性） |
| 409 | `conflict` | 重复上传（相同 `content_hash`）、版本冲突 |
| 422 | `validation_error` | 参数不合法 |
| 429 | `rate_limited` | 限流（Redis） |
| 500 | `internal_error` | 其他错误，只返回 `request_id`，细节在日志里 |

- 列表接口：`limit`（默认 20，最大 100）+ `cursor`，返回 `{ "items": [...], "next_cursor": "…|null" }`。
- 每个请求带 `X-Request-Id`（没有就生成），写入日志和 trace。

## 2. 端点一览

| 分组 | 方法与路径 | 谁能调用 |
|---|---|---|
| 健康 | `GET /healthz` | 公开 |
| 身份 | `GET /me` | 已登录 |
| 会话 | `POST /conversations`、`GET /conversations`、`GET /conversations/{id}`、`PATCH /conversations/{id}`、`DELETE /conversations/{id}` | 已登录，仅限自己的会话 |
| 对话 | `POST /conversations/{id}/messages`、`GET /conversations/{id}/messages` | 同上 |
| 文档管理 | `POST /documents`、`GET /documents`、`GET /documents/{id}`、`PATCH /documents/{id}`、`DELETE /documents/{id}`、`POST /documents/{id}/reindex`、`GET /documents/{id}/jobs` | `RAGETLAdmin` |
| 文档阅读 | `GET /documents/{id}/chunks`、`GET /documents/{id}/file` | 已登录，且按权限过滤（见 4.2） |

评测和审计查询第一阶段**不提供 API**：评测用命令行运行并输出报告，审计日志只在数据库里（第二阶段可加 `Auditor` 角色的查询接口）。

## 3. 身份与会话

### `GET /me`

```json
{ "user_id": "…", "name": "…", "roles": ["staff"], "campus_id": "SH", "level": "S2" }
```

内容全部来自 JWT 声明，前端用它决定显示哪些菜单（文档管理页只对 `RAGETLAdmin` 显示）。**前端的显示不是权限，后端每个接口都再次校验。**

### 会话

- `POST /conversations` → `{ "id", "title": null, "created_at" }`。标题由第一轮问答后自动生成，也可 `PATCH` 修改。
- `DELETE` 是**归档**（`archived = true`），不物理删除，与审计一致。
- 会话只有创建者能访问，别人的会话 ID 返回 404。

## 4. 对话

### 4.1 `POST /conversations/{id}/messages`

请求：

```json
{ "content": "I submitted an assignment 50 hours late and my raw score was 90. What is my final score?" }
```

响应（第一阶段为一次性 JSON，**结构已为第二阶段的流式输出预留**）：

```json
{
  "run_id": "…",
  "message": {
    "id": "…",
    "role": "assistant",
    "content": "50 hours late falls into the 48 to 72 hour band: 30 percent … final score 63. [1]",
    "citations": [
      { "n": 1, "doc_code": "TS-HW-006", "title": "…", "version": "1.0",
        "status": "active", "heading_path": ["…"], "page": 2, "chunk_id": "…",
        "kind": "document" }
    ]
  },
  "end_state": "answered",
  "end_reason": null
}
```

- `end_state` 取值与原因码见文档 04：`answered`、`need_clarification`、`no_permission`、`not_found`、`refused`、`error`。**每次运行都必须返回其中之一**。
- `need_clarification`：`message.content` 是反问内容，用户在同一会话里继续回复即可，状态由图的会话状态字段保存，不依赖隐式变量。
- `no_permission` / `not_found`：回答文案固定、不透露受限内容，不返回引用。
- 引用只包含**用户有权看到的**文档；`n` 与正文中的 `[n]` 对应。
- 请求超时：服务端对一次运行设上限（**【建议】** 60 秒），超时以 `end_state: "error"`、`end_reason: "timeout"` 结束，不返回 5xx。

流式版本（M9 已实现）：同一路径，请求头 `Accept: text/event-stream`。限流、归属检查与非流式相同，在流开始前返回普通 JSON 错误（401/404/409/429）。事件：

| event | data |
|---|---|
| `run.started` | `{ "run_id" }` |
| `message.delta` | `{ "text" }`：追加到当前回答 |
| `message.retract` | `{ "reason" }`：撤回此前已显示的全部回答文字（草稿未通过校验），随后可能再出现新的 `message.delta` |
| `citations` | `{ "citations": [...] }`，同上 `citations` 数组 |
| `run.ended` | `{ "run_id", "message_id", "end_state", "end_reason", "content" }`：`content` 是最终存档的回复，客户端应以它为准 |
| `error` | `{ "code", "message" }`：仅在运行本身意外崩溃时出现，之后流结束 |

约定：`generate` 先输出 `sufficient`，确认为 `true` 之后才开始流出 `answer`（"先流出，不通过时撤回"）；固定文案（澄清、拒答、未找到等）作为一个 `message.delta` 一次发出；每 15 秒无事件时发送注释行 `: keepalive`；客户端断开后运行在服务端继续并存档，回来后可从消息列表读到。

### 4.2 `GET /documents/{id}/chunks` 与 `GET /documents/{id}/file`

- 用于点击引用后查看原文。**权限判定与检索使用同一个过滤函数**；不满足时返回 404。
- `RAGETLAdmin` 只有在自己的业务角色允许时才能读内容（见 01 的 4.3）；否则只能看到元数据（`GET /documents` 的返回）。

## 5. 文档管理（仅 `RAGETLAdmin`）

### `POST /documents`（multipart/form-data）

| 字段 | 必填 | 说明 |
|---|---|---|
| `file` | 是 | docx / pdf / md / txt |
| `doc_code`、`title`、`domain`、`version` | 是 | |
| `status` | 否 | 默认 `active` |
| `effective_date` | 否 | |
| `access_level` | 是 | 取值见 02 的 2.3 展开表 |
| `allowed_users` | 否 | Keycloak `sub` 数组 |
| `campus_scope` | 否 | 默认 `["all"]` |
| `min_level` | 否 | |
| `supersedes` | 否 | 被取代的旧版本 `id` |

行为：写入对象存储、写 `ai.documents`（`ingest_status = queued`）、插入 `ingestion_jobs`，**立即返回 202**，包含文档和任务 ID。相同 `content_hash` 且相同 `(doc_code, version)` 返回 409 并给出已有文档 ID。

> **M7 修订（2026-11-03）**：实际实现与上面的差异：`min_level` 是 1–7 的等级序号；`domain` 取 `hr`、`finance`、`tech-support`；单文件 ≤ 20 MB，扩展名与文件头必须一致；相同 `(doc_code, version)` 已存在即返回 409（消息里带已有文档的 `id`）；列表用 `limit` + 不透明的 `cursor`（编码的是偏移量）；文档类引用带 `document_id`，用它请求 `GET /documents/{id}/chunks?around={chunk_id}&window=1` 得到被引用的块和前后各 1 块；`GET /documents/{id}/file` 返回原文件（`Content-Disposition: inline`）。浏览器跨域访问由 `STARIT_CORS_ORIGINS` 控制（默认 `http://localhost:3000`，只允许 `Authorization`、`Content-Type`、`X-Request-Id` 头，不带 cookie）。

### 其余端点

- `GET /documents`：过滤参数 `domain`、`status`、`ingest_status`、`q`（标题或编号）。返回元数据，**不含正文**。
- `PATCH /documents/{id}`：可改标题、状态、`access_level`、`allowed_users`、`campus_scope`、`min_level`。权限或状态变化通过 02 的服务函数，**同一事务更新文档和所有分块**，并写审计记录。
- `DELETE /documents/{id}`：硬删除文档、分块、向量、派生内容和原文件（文档管理动作，写审计）；会话历史里的引用保留 `doc_code` 文本，不再可点击。
- `POST /documents/{id}/reindex`：创建新的入库任务，成功后原子替换旧分块。
- `GET /documents/{id}/jobs`：入库任务历史，含 `stage`、`attempt`、`error_code`、`error_message`。

## 6. MCP Server【建议】

### 6.1 传输与认证

- 独立进程，端口 8100，Streamable HTTP。
- Agent 调用工具时**转发当前用户的 JWT**；MCP Server 用同一个 JWKS 自行校验，并检查 `aud` 包含 `starit-mcp`。Keycloak 给前端客户端的访问令牌同时带 `starit-api` 和 `starit-mcp` 两个受众。【待定】更严格的做法是令牌交换（token exchange），第一阶段不做。
- 所有工具读取身份的方式相同：JWT → 设置数据库会话变量 → 经 `ai_sql_ro` 访问白名单视图，或调用 `core` 的检索函数。工具**不接受**任何身份参数。

> **M6 修订（2026-11-03）**：引用新增 `kind` 字段。`"document"` 如上；`"data"` 表示答案来自业务数据：`{ "n": 1, "kind": "data", "views": ["students"], "row_count": 12 }`。`search_documents` 实际的 `top_k` 最大 8，无 `doc_code` 参数，`domain`（hr/finance/tech）按 `doc_code` 前缀过滤，只返回 `doc_code`、`title`、`version`、`heading_path`、`text`。所有工具返回 `{"ok": true, ...}` 或 `{"ok": false, "error": {"code", "message"}}`，错误码 `forbidden`、`not_found`、`invalid_argument`、`internal_error`。

### 6.2 首批工具（已确认范围：文档检索、课程与学员只读、报销状态）

| 工具 | 输入 | 输出 |
|---|---|---|
| `search_documents` | `query`（必填）、`top_k`（默认 5，最大 10）、`domain`、`doc_code` | 列表：`chunk_id`、`doc_code`、`title`、`version`、`status`、`heading_path`、`page`、`text`、`score` |
| `list_assignments` | `program`（可选） | 作业列表（`assignment_id`、`program`、`title`、`due_date`） |
| `list_students` | `campus_id`、`program`、`cohort`、`limit`（默认 20） | 学员列表（按视图的行级规则过滤，学员只会看到自己） |
| `get_student_progress` | `student_id` | 该学员的提交记录：作业、迟交小时数、原始分、扣分比例、最终分 |
| `get_expense_claim_status` | `claim_id` | 状态、金额、类别、提交日期、审批角色（仅本人或有权限者） |
| `list_my_expense_claims` | `status`（可选）、`limit` | 当前用户提交的报销单 |

约定：
- 工具使用**固定的参数化查询**，不接受 SQL 字符串。自由问法的数据问题由 Agent 内部的只读 SQL 工具处理（带语句校验、超时和行数限制，见 02 的第 5 节），它不经过 MCP。
- 输出里**不返回用户无权看到的行**，也不返回"有多少行被过滤"这类信息。
- 工具错误用 MCP 标准错误，`code` 取 `forbidden`、`not_found`、`invalid_argument`、`internal_error`。
- 每次调用写 `audit_log`（`action = mcp.<tool>`），记录用户、工具、参数摘要、返回行数。

## 7. 限流与超时【建议】

- 对话接口：每用户每分钟 20 次；文档上传：每用户每分钟 5 次（Redis 计数）。
- 单次运行上限 60 秒；单个 LLM 调用上限 30 秒，失败可重试一次；检索和 SQL 工具各有独立超时。
- 文件上传大小上限：20 MB（可配置）。

## 8. 需要你确认的点

1. 第 2 节的端点划分，尤其"评测只用命令行、审计第一阶段无 API"，是否接受？
2. 第一阶段对话接口返回一次性 JSON，响应结构预留流式（第二阶段加 SSE），是否接受？
3. 对无权访问的文档返回 404（不泄露存在性），是否接受？
4. `RAGETLAdmin` 只有自己的业务角色允许时才能读文档内容，否则只能看元数据，是否接受？
5. 6.2 的 MCP 工具清单和参数，是否接受？（尤其 `list_students` 对学员只返回自己）
6. MCP 转发用户 JWT、检查 `aud`，第一阶段不做令牌交换，是否接受？
7. 7 节的限流和超时数值是否接受？

## 9. 确认结果（2026-11-02）

7 个确认点全部接受：端点划分（评测用命令行、审计第一阶段无 API）；第一阶段返回一次性 JSON、结构预留流式；无权访问返回 404；`RAGETLAdmin` 读内容受业务角色限制；MCP 工具清单；MCP 转发用户 JWT 并检查 `aud`；限流和超时数值。
