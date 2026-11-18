<p align="center">
  <img src="assets/logo/logo.svg" alt="StarIT Education 标志：灯塔把光射向一弧星星" width="160">
</p>

# StarEdu

[English](README.md) · **[从这里开始：TRY-IT.chn.md](TRY-IT.chn.md)**（配置 Docker、运行、登录用的账号）

一个开源蓝本：给传统业务系统加上 AI。它把一个培训公司的**多租户后台**和一个 **AI 知识助手**（RAG 和智能体）放在一起，用同一家示例公司 **StarIT Education**（一家有八个校区的 IT 培训公司）作为贯穿始终的例子。助手可以用后台自己的数据回答问题，以同一个人的身份登录，只看到这个人有权看到的内容。

## 两个部分

| 部分 | 是什么 | 需要 | 文档 |
|---|---|---|---|
| **业务模块**（[`business-module/`](business-module/)） | 多租户 SaaS 后台：人员、教学和选课、作业和成绩、成绩单、通知、文档库。三个入口：学生门户、管理后台、平台控制台。自带演示公司和账号。NestJS、Prisma、PostgreSQL、Next.js 15、Keycloak。 | Docker、Node.js 20.19+、pnpm 10。**不需要 API key。** | [概览](business-module/README.chn.md) · [试用](business-module/TRY-IT.chn.md) |
| **AI 模块**（[`ai-module/`](ai-module/)） | 带权限感知的知识助手：回答文档问题和数据问题，带引用，按提问的人过滤结果。FastAPI、LangGraph、PostgreSQL + pgvector、MCP、LiteLLM。 | Docker、uv、make、OpenAI API key | [说明](ai-module/README.chn.md) |
| **两个一起用** | 从后台的“AI 助手”菜单打开助手，用公司自己的登录，向后台询问这个人能读什么。 | 上面两个都要 | [TRY-IT 里的路径 C](TRY-IT.chn.md#5-路径-c两个一起用) |

## 几分钟跑起来

请读 [TRY-IT.chn.md](TRY-IT.chn.md)：它说明要装什么、怎么给 Docker 足够的内存、每个部分的命令，以及用哪些演示账号。简单说，最快看到东西的是业务模块（免费、不要 key）：

```bash
cd business-module
cp .env.example .env && pnpm install
make up && pnpm migrate && pnpm realm && pnpm demo
pnpm dev:api        # 一个终端
pnpm dev:web        # 另一个终端
```

然后打开 <http://hq.localhost:3001>，在登录页点一个演示账号即可。

## 想看什么，去哪里

| 想看 | 去哪里 |
|---|---|
| 怎么运行、账号、重置、排错 | [`TRY-IT.chn.md`](TRY-IT.chn.md) |
| 业务模块做什么、怎么做的（租户隔离、权限、地址） | [`business-module/README.chn.md`](business-module/README.chn.md) |
| AI 模块做什么、问题怎么路由、怎么测试、代码结构 | [`ai-module/README.chn.md`](ai-module/README.chn.md) |
| 在后台里每个角色可以点什么 | [`business-module/TRY-IT.chn.md`](business-module/TRY-IT.chn.md) |
| 搭一个公网试用站 | [`business-module/deploy/trial/README.md`](business-module/deploy/trial/README.md) |
| 需求、设计文档、评测报告 | [`docs/`](docs/)（[需求](docs/project-requirements.chn.md)、[设计](docs/design/)、[评测](docs/eval/)） |

## 目录结构

```
StarEdu/
├── README.md, TRY-IT.md     本概览和唯一的起点（中文是 README.chn.md、TRY-IT.chn.md）
├── business-module/         多租户后台（pnpm 工作区：apps/api、apps/web、packages/shared）
├── ai-module/               AI 模块（uv 工作区：packages/core、apps/api、worker、mcp-server、web、eval）
├── docs/                    需求、设计文档和评测报告
├── assets/logo/             品牌标志
└── LICENSE                  MIT
```

更详细的目录树在各模块自己的 README 里。

## 当前状态

1. AI 模块：做到里程碑 M9（接下来做什么见[第二阶段计划](docs/design/09-phase2-plan.chn.md)）。
2. 业务模块：做到里程碑 B31，带演示数据和公网试用模式。
3. 下一步：部署到公网服务器（完整版和精简版）和公网演示。
4. 之后：示例数据的中文版。

所有示例数据都是合成的：公司、姓名、数字、制度和网址（`*.starit.example`）都是虚构的。

## 许可证

MIT，见 [LICENSE](LICENSE)。
