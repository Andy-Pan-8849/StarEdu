# 试用 StarEdu

[English](TRY-IT.md) · [项目总览](README.chn.md)

这是唯一的起点。它说明要装什么、怎么配置 Docker、怎么运行每个部分、用哪些账号登录，以及出问题时怎么办。

## 1. 选一条路径

| 路径 | 你会得到什么 | 需要 |
|---|---|---|
| **B：业务模块**（从这里开始） | 一个培训公司的多租户后台，带演示公司和账号。免费。 | Docker、Node.js 20.19+、pnpm 10。**不需要 API key。** |
| **A：AI 模块** | 一个知识助手：在聊天页提问，得到带引用的回答，结果按提问的人过滤。问几个问题大约花几分钱的模型调用费。 | Docker、uv、make、OpenAI API key |
| **C：两个一起用** | 助手从后台打开，用后台的数据回答，以同一个人的身份登录。 | B 和 A，再加几项设置；或者直接 `make start-all`（第 5 节） |

## 2. 你需要什么

| 需要 | 路径 B | 路径 A |
|---|---|---|
| 带 Compose 的 Docker | 要 | 要 |
| Node.js 20.19+ 和 pnpm 10 | 要 | 不要 |
| uv 和 make | 只要 `make` | 要 |
| OpenAI API key | 不要 | **要** |

**Docker 内存。** 业务模块要几 GB，AI 模块要 8 GB 以上。两个一起要两者之和（没实测过，尽量多给 Docker）。在 Docker Desktop 里：Settings > Resources > Memory。查看 Docker 现在有多少：`docker info --format '{{.MemTotal}}'`（单位是字节）。

**端口。** 两部分用不同的端口，互不冲突：

| 服务 | 业务模块 | AI 模块 |
|---|---|---|
| 网页 | 3001 | 3000 |
| API | 4000 | 8000 |
| Postgres / Redis | 5433 / 6380 | 5432 / 6379 |
| Keycloak（登录） | 8180 | 8080 |
| 其他 | Mailpit 8125（邮件收件箱）、对象存储 9100/9101 | |

**地址。** 业务模块靠主机名区分公司，所以 `*.localhost` 必须解析到你的电脑（Chrome、Edge、Firefox 自带这个行为；否则把 `hq.localhost`、`riverside-franchise.localhost`、`platform.localhost` 加到 `/etc/hosts`，指向 `127.0.0.1`）。

## 3. 路径 B：业务模块

在仓库根目录：

```bash
cd business-module
cp .env.example .env      # 默认值只用于本机演示
pnpm install
make up                   # Postgres、Redis、对象存储、Keycloak、Mailpit；等它们变成 healthy
pnpm migrate              # 创建数据库结构
pnpm realm                # 创建平台登录域
pnpm demo                 # 演示公司、账号和数据（可重复执行）
```

然后各开一个终端启动两个服务：

```bash
pnpm dev:api              # http://localhost:4000/healthz 应返回 {"status":"ok", ...}
pnpm dev:web
```

打开 <http://hq.localhost:3001>。登录页的“登录”按钮下面列着演示账号：点一个就登录了。第 6 节的表说明哪个账号对应哪个入口。每个角色可以试什么、数据是怎么组织的、排错清单，见 [`business-module/TRY-IT.chn.md`](business-module/TRY-IT.chn.md)。

## 4. 路径 A：AI 模块

```bash
cd ai-module
make env                  # 生成 .env；把你的 OPENAI_API_KEY 填进去
make sync && make up && make seed
```

打开 <http://localhost:3000>，用 `wei.stu.sh` 登录，密码 `demo-pass-123`（本机演示账号）。然后：

- 问 `What does ERR-PORTAL-429 mean?`：得到带引用的回答，可以点开引用看原文。
- 退出，用 `qing.hr.bj`（HR）登录，问 `What is the base salary band for a Senior Instructor at a Tier 1 campus?`：HR 能得到薪资区间。用 `wei.stu.sh` 问同一个问题，学员得到固定的“找不到”回复，不会暗示存在受限文档。

八个演示账号，以及每个账号的三个普通问题和两个受限问题，在 [`ai-module/README.chn.md`](ai-module/README.chn.md) 里。

## 5. 路径 C：两个一起用

### 一条命令

在项目根目录，Docker 已运行，并装好 `uv`、`node`、`pnpm`：

```bash
make start-all
```

它会替你做下面所有的事：缺少 `.env` 就创建两份，为两个模块生成同一个共享密钥并在 AI 模块里打开业务模式，启动两边的容器，建表和平台登录域，装入演示数据和样本知识库，然后在后台启动业务 API、业务网页和 AI 网页（日志在 `.run/`）。等它们都响应了就打印地址。第一次运行很慢（要拉镜像、装依赖），之后会快很多。先把 `OPENAI_API_KEY` 填进 `ai-module/.env`，否则一切都能启动，只是助手没法回答。

```bash
make status      # 看进程、端口、容器
make stop-all    # 停掉后台进程和两边的容器（数据保留）
```

注意：这会把 AI 模块切到业务模式——你从后台里进入助手，3000 端口上单独的 AI 账号（`wei.stu.sh` 等）就不能用了。想改回去，删掉 `ai-module/.env` 里的 `STARIT_IDENTITY_MODE` 一行并重启 AI 模块。脚本是 [`scripts/dev-all.sh`](scripts/dev-all.sh)；`make wire` 只执行它的配置步骤。

### 分步操作

在*业务模式*下，你用公司自己的登录进入，助手向后台询问这个人可以看哪些数据行和文件夹，并且只通过按这个范围过滤的视图读取。学生问“所有学生的成绩”，只会得到自己的。

1. 先完成路径 B 和路径 A（AI 模块要有可用的 `.env` 并已 `make up`）。
2. 在两边的 `.env` 里设置共享密钥和身份模式，然后迁移并重启。具体变量见 [`business-module/TRY-IT.chn.md`](business-module/TRY-IT.chn.md#业务模式下的-ai-助手)。在此之前创建的公司需要执行 `pnpm demo:reset`，因为它们没有助手用的登录客户端。
3. 用 `demo.teacher` 或 `demo.student1` 登录后台，点 **AI 助手**。

## 6. 日常使用

**账号。** 业务模块所有演示账号的密码都是 `Demo!Passw0rd2026`；AI 模块是 `demo-pass-123`。两个都是公开的演示密码，只用于本机。

| 想试 | 账号 | 地址 |
|---|---|---|
| 学生门户 | `demo.student1` | <http://hq.localhost:3001> |
| 老师（管理后台） | `demo.teacher` | <http://hq.localhost:3001/admin> |
| 管理后台的全部功能 | `demo.admin` | <http://hq.localhost:3001/admin> |
| 教务 | `demo.registrar` | <http://hq.localhost:3001/admin> |
| 另一家公司（隔离） | `rv.admin` | <http://riverside-franchise.localhost:3001/admin> |
| 平台控制台 | `demo.operator` | <http://platform.localhost:3001> |
| 单独的 AI 聊天 | `wei.stu.sh`、`qing.hr.bj` | <http://localhost:3000> |

其他工具：邮件收件箱 <http://localhost:8125>，Keycloak 管理台 <http://localhost:8180>（默认 `admin` / `admin`），API 文档 <http://localhost:4000/api-docs>（仅开发环境）。

**检查、停止、重置。**

```bash
docker ps --format '{{.Names}} {{.Status}}'      # 每个容器都应是 Up / healthy
cd business-module && pnpm demo:reset            # 用新日期重建演示数据
cd business-module && make down                  # 停止（保留数据）；make reset 会删除本模块的数据
cd ai-module && make down                        # 停止（保留数据）；make clean 连数据一起删
make status                                      # （项目根目录）make start-all 之后：看进程和端口
make stop-all                                    # （项目根目录）停掉 make start-all 启动的一切
```

## 7. 出问题时

| 现象 | 怎么办 |
|---|---|
| `*.localhost` 打不开 | 把这些名字加到 `/etc/hosts`（第 2 节）。 |
| 登录页没有演示账号 | Docker 没看到主题文件夹（切换 git 分支后常见）。在 `business-module/` 下：`docker compose --env-file .env -f deploy/compose/biz.yaml up -d --force-recreate keycloak`，然后刷新页面。 |
| 在管理后台登录后提示“无权限” | 这个账号只能用门户。请用 `demo.admin`。 |
| 公司管理员看到的列表是“没有内容” | 按设计，管理员没有业务数据范围；请用 `demo.admin` 或 `demo.registrar`。 |
| 截止日期看起来过期了 | 执行 `pnpm demo:reset`。 |
| 端口被占用 | 对照第 2 节的表。 |
| API 启动时报 “Invalid environment” | 用 `pnpm dev:api` 启动（它会读取 `.env`），并确认 `.env` 存在。 |

更多见 [`business-module/TRY-IT.chn.md`](business-module/TRY-IT.chn.md#6-重置与常见问题)，AI 模块的见 [`ai-module/README.chn.md`](ai-module/README.chn.md)。

## 8. 想找什么

| 想找 | 去哪里 |
|---|---|
| 系统做什么、怎么做的 | [`README.chn.md`](README.chn.md)、[`business-module/README.chn.md`](business-module/README.chn.md)、[`ai-module/README.chn.md`](ai-module/README.chn.md) |
| 后台里每个角色可以点什么 | [`business-module/TRY-IT.chn.md`](business-module/TRY-IT.chn.md) |
| 搭一个公网试用站 | [`business-module/deploy/trial/README.md`](business-module/deploy/trial/README.md) |
| 设计文档和评测报告 | [`docs/`](docs/) |
