# 试用 StarEdu

[English](TRY-IT.md) · [项目总览](README.chn.md)

StarEdu 有两部分，都能在你自己的机器上运行，可以一起跑，也可以只跑一个：

| 部分 | 你能看到什么 | 需要 | 详细指南 |
|---|---|---|---|
| **AI 模块** | 企业知识助手：在聊天页提问，得到带引用的回答，结果按提问者的身份过滤。 | Docker Compose、uv、make、OpenAI 密钥 | [`ai-module/README.chn.md`](ai-module/README.chn.md) |
| **业务模块** | 面向培训公司的多租户后台：人员、教学、作业、成绩、成绩单、通知、文档。自带演示公司和账号。 | Docker Compose、Node.js 20.19+、pnpm 10，**不需要任何密钥** | [`business-module/TRY-IT.chn.md`](business-module/TRY-IT.chn.md) |
| **两个一起** | 助手直接用后台的数据回答问题，用公司自己的登录。 | 上面两个都要 | 下面的路线 C |

## 我该走哪条路线？

- **想看后台**（权限、数据范围、租户隔离，一个真实的 SaaS 是怎么做的）：路线 B。免费、不要密钥，演示也更丰富。
- **想看 AI 助手**：路线 A。问几个问题大约花几美分的模型调用费。
- **想看两者配合**：先 B，再 A，最后路线 C。

## 你的机器需要什么

| 需要 | 路线 A | 路线 B |
|---|---|---|
| Docker（含 Compose） | 要，内存 8 GB 或以上 | 要，几 GB |
| Node.js 20.19+ 和 pnpm 10 | 不要 | 要 |
| uv 和 make | 要 | Docker 服务用 `make` 启动 |
| OpenAI 密钥 | **要** | 不要 |

两个一起跑需要两边内存之和，这个我没有实测，请尽量给 Docker 多分配一些。两边端口不同，不会冲突：

| 服务 | AI 模块 | 业务模块 |
|---|---|---|
| 网页 | 3000 | 3001 |
| 接口 | 8000 | 4000 |
| Postgres / Redis | 5432 / 6379 | 5433 / 6380 |
| Keycloak | 8080 | 8180 |

## 路线 A：AI 模块

```bash
git clone https://github.com/Andy-Pan-8849/StarEdu.git
cd StarEdu/ai-module
make env            # 生成 .env，把 OPENAI_API_KEY 填进去
make sync && make up && make seed
```

打开 <http://localhost:3000>，用 `wei.stu.sh` 登录，密码 `demo-pass-123`（仅限本地的演示账号）。然后：

- 问 `What does ERR-PORTAL-429 mean?`：得到带引用的回答，引用可以点开看原文。
- 退出后用 `qing.hr.bj`（HR）登录，问 `What is the base salary band for a Senior Instructor at a Tier 1 campus?`：HR 得到薪资带。用 `wei.stu.sh` 问同一个问题，学员得到固定的"找不到"话术，不会暗示存在受限文档。

八个演示账号，每个账号三个正常问题和两个受限问题，见 [`ai-module/README.chn.md`](ai-module/README.chn.md)。停止用 `make down`；`make clean` 连数据一起删。

## 路线 B：业务模块

```bash
cd StarEdu/business-module
cp .env.example .env
pnpm install
make up && pnpm migrate && pnpm realm
pnpm demo                      # 演示公司、账号和数据
pnpm dev:api                   # 一个终端
pnpm dev:web                   # 另一个终端
```

打开 <http://hq.localhost:3001>。每个登录页的"登录"按钮下面都列着演示账号，点一个就能进去。可以用 `demo.student1` 试学生门户，用 `demo.admin`（一个账号拥有全部管理菜单）试管理后台，用 `demo.operator` 登录 <http://platform.localhost:3001/> 试平台控制台。分角色该试什么、怎么重置数据（`pnpm demo:reset`）、常见问题，见 [`business-module/TRY-IT.chn.md`](business-module/TRY-IT.chn.md)。

## 路线 C：两个一起（助手用后台的数据回答）

助手可以运行在*业务模式*：你用公司自己的登录进去，助手向后台询问这个人能看哪些数据行和文件夹，并且只通过按这些范围过滤的视图读数据。学生问"所有学生的成绩"，只会得到自己的。

1. 先完成路线 B 和路线 A（AI 模块要有可用的 `.env`，并已 `make up`）。
2. 在两边的 `.env` 里设置同一个共享密钥和身份模式，然后迁移并重启。具体变量见 [`business-module/TRY-IT.chn.md`](business-module/TRY-IT.chn.md#业务模式下的-ai-助手)。
3. 用 `demo.teacher` 或 `demo.student1` 登录后台，点 **AI assistant**。

## 停止与清理

```bash
cd ai-module && make down            # 保留数据（make clean 会删除数据）
cd ../business-module && make down
```

## 其他内容在哪里

| 想找 | 去哪里 |
|---|---|
| 系统做什么、怎么做的 | [`README.chn.md`](README.chn.md)、[`business-module/README.chn.md`](business-module/README.chn.md) |
| 搭一个公开试用站 | [`business-module/deploy/trial/README.md`](business-module/deploy/trial/README.md)（英文） |
| 设计文档和评测报告 | [`docs/`](docs/) |
