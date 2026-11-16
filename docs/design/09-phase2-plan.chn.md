# 设计文档 09：第二阶段（P1）规划

状态：**草案，2026-11-04**，依据用户对 [架构图对照验收表](../eval/架构图对照验收表.html) 的决定。第一阶段（`v0.1.0`）的结果见 [acceptance-v0.1.0.md](../eval/acceptance-v0.1.0.chn.md)。具体的里程碑清单写在 [08](08-milestone-checklists.chn.md)（M9 起），这份文档只放"决定了什么、排在哪、不做什么"。

## 1. 用户的决定（2026-11-04）

| 项 | 决定 |
|---|---|
| M8 的尾巴：20% 人工抽查、`understand` 过度反问、"没答案仍标已回答"、Anthropic 与 fallback 验证 | **做**（M9） |
| 流式输出 | **做**（M9）。采用"先流出，校验不通过时撤回" |
| 成本与延迟统计 | **不做自己的**：Langfuse 已经按模型和会话算出成本（full profile）。lite profile 没有 Langfuse，做 lite 时重新决定 |
| Memory | 先不做，等企业后台有了再做 |
| 写操作确认 | 先不做，等企业后台有了再做 |
| 限流 3 维 | **做**（M9）：IP / 用户 / token 三个维度；token 维度定为全栈每日不超过 0.5 美元 |
| LiteLLM 多模型 fallback | **做**（M9）：`openai/gpt-6-luna` → `openai/gpt-4o-mini` → `anthropic/claude-haiku-5-5`；只验证 Haiku 可用，不用它跑完整评测 |
| 图上有、需求清单里没有也没规划的几项 | **列入第二阶段**（本文第 3 节），**暂不排期** |

## 2. 已排期

| 里程碑 | 内容 |
|---|---|
| M9 | 上面标"做"的各项：M8 收尾、流式输出、三维限流、模型 fallback |

## 3. 列入第二阶段、未排期的候选（来自架构图）

用户点名的三项：

| 项 | 图上的位置 | 现状 |
|---|---|---|
| 输出端护栏：PII 脱敏、敏感词 | ④ Guardrail 后置检查；③ FastAPI 的 PII 脱敏 | 没有。输出没有再过一道过滤 |
| Jailbreak 检测 | ④ Guardrail 前置检查 | 只有几条正则的 Prompt Injection 检查 |
| MCP Resources（URI 定位的只读数据源） | ⑤ MCP Server | 只有 Tools |

图上其余"没规划"的项，一并列为候选（范围待用户确认）：

| 项 | 图上的位置 |
|---|---|
| Analytics Agent（数据分析、图表、报表） | ④ |
| Web Search Agent | ④ |
| Local vLLM（敏感数据兜底） | ⑥ |
| Redis 的会话、JWT 黑名单、响应缓存、分布式锁、Pub/Sub | ⑦ |
| Vault 密钥管理、Sentry 错误追踪 | ⑧ |
| 边缘反向代理（Nginx / Cloudflare）、CDN + WAF | ② |
| PostgreSQL 主从与 PITR 备份 | ⑦ |

## 4. 之前就排在后面的

| 项 | 来源 |
|---|---|
| 企业后台（NestJS 业务模块）——Memory 和写操作确认等它 | 需求文档子项目 2 |
| lite profile（Oracle k3s、Helm、身份方案） | 07 第 6 节、06 第 3 节 |
| Auditor 角色与审计查询接口 | 03 第 2 节 |
| 加盟店数据、中文版数据 | 07 第 6 节 |
| BM25 扩展（评测说暂不需要） | 05 第 2.1 节 |
| Loki 集中日志 | 06 第 6 节 |
| 对话上下文的摘要（现在只截断最近 6 轮） | 需求清单 C |
