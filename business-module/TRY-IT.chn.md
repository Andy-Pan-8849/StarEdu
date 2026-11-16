# 试用指南（给学习者和雇主）

[English](TRY-IT.chn.md) · [系统是什么、怎么做的](README.chn.md)

这份指南带你在自己的电脑上把业务模块跑起来，装入一家逼真的公司，并告诉你以每种用户的身份该点什么。Docker 拉完镜像之后，大约 15 分钟。

## 1. 你需要什么

| 需要 | 说明 |
|---|---|
| Node.js **20.19 及以上**和 **pnpm 10** | `node -v`、`pnpm -v` |
| 带 Compose 的 **Docker** | 给 Postgres、Redis、对象存储、Keycloak 和 Mailpit 留几个 GB 的空闲内存。AI 模块有自己独立的 Compose 项目和不同的端口，两边可以同时运行。 |
| macOS、Linux 或 Windows | Windows 用 Docker Desktop 即可；遇到问题可以改用 WSL。 |
| 一个现代浏览器 | `*.localhost` 要能解析到本机（Chrome、Edge、Firefox 都可以；否则把 `hq.localhost`、`riverside-franchise.localhost`、`platform.localhost` 加到 `/etc/hosts`）。 |
| 空闲端口 | Postgres 5433、Redis 6380、对象存储 9100/9101、Keycloak 8180、Mailpit 1125 和 8125、接口 4000、网页 3001。 |

业务模块本身不需要任何 API 密钥。（可选的 AI 助手需要 AI 模块和大模型密钥，见第 7 节。）

## 2. 搭建

在 `business-module/` 目录里：

```bash
cp .env.example .env        # 默认值只用于本地演示
pnpm install
make up                     # Postgres、Redis、对象存储、Keycloak、Mailpit（等它们都健康）
pnpm migrate                # 建数据库表结构
pnpm realm                  # 创建平台登录域
```

然后装入试用数据（第 3 节），再在两个终端里启动两个服务：

```bash
pnpm dev:api                # http://localhost:4000/healthz  ->  {"status":"ok", ...}
pnpm dev:web                # http://hq.localhost:3001
```

发出去的邮件（邀请、通知）在 Mailpit 里看：<http://localhost:8125>。Keycloak 管理台在 <http://localhost:8180>（`.env` 里默认 `admin` / `admin`）。

## 3. 装入试用数据

```bash
pnpm demo
```

`pnpm demo` 等于 `pnpm seed`（开通两家公司）+ `pnpm import:sample`（导入 AI 模块样本公司的人员）+ `pnpm seed:demo`（教学数据、演示账号、文档）。要一两分钟，可以放心重复运行。

你会得到：

| 公司 | 地址 | 内容 |
|---|---|---|
| **StarIT**（`hq`） | <http://hq.localhost:3001> | 数据最全：8 个校区、约 200 人（样本公司里的 141 名员工和 60 名学员）、一个已结束的春季学期（20 个班、198 份已批改的提交）、27 个文件的文档库，加上下面的**演示场景**。 |
| **StarIT RiverSide**（`riverside-franchise`） | <http://riverside-franchise.localhost:3001> | 同一套系统里的加盟商：一家小而完整的独立公司（课程编码相同、人员和数据不同），用来证明两家公司互相看不到。 |

**演示场景**（相对你加载那天生成，两家公司都有）：

- 一个已结束的*上学期*，成绩几天前发布（所以 14 天的复评窗口还开着），并有一条成绩更正记录；
- 一个选课中的*本学期*，三个班（Java 班接近满员），每个班都有：作业 1 已批改发布、作业 2 已提交但**还没批改**（有迟交）、作业 3 还开着、一个手工录分的期中考、一份未发布的项目草稿；
- 一个计划中的*下学期*；
- 学生申请：待处理的延期和复评各一条，已批准和已驳回各一条；
- 公告（全公司、校区、班级）、讨论（置顶、有回复、已解决）、消息、一份有效和一份已作废的正式成绩单、新旧两版培养方案，以及账号和存储上限（平台的使用情况页才有东西可看）。

因为日期是相对的，**演示之前先运行 `pnpm demo:reset`**，拿到新的截止日期。它会清空演示公司的业务数据（保留公司本身、登录域、内置管理员、角色、部门和校区），删掉它们的演示用户，重新导入样本并重新生成全部内容。它不会碰任何没有标记为演示公司的公司。

## 4. 用演示账号登录

打开任意一个入口的登录页：

| 入口 | 地址 |
|---|---|
| 学生门户 | <http://hq.localhost:3001/> |
| 管理后台 | <http://hq.localhost:3001/admin> |
| 平台控制台 | <http://platform.localhost:3001/> |

在 **Sign in** 按钮下面有一块，写着 *"The accounts below are for demonstration only."*（以下账号仅用于演示），列出两家公司和平台的演示账号。**点一个就登录**；账号属于别的入口或公司时，会先带你过去再登录，所以不用跳来跳去。所有账号的密码都是 `Demo!Passw0rd2026`。

| 账号 | 入口 | 用途 |
|---|---|---|
| `demo.admin` | 管理后台 | **演示超级账号**：拥有全部管理菜单和按钮和"全部数据"范围，还是 Python 班的助教。一个账号就能看全部功能。 |
| `demo.registrar` | 管理后台 | 教务：学期、课程、专业、班级、选课、批量选课、成绩更正、成绩单、学生申请。 |
| `demo.teacher` | 管理后台 | 本学期三个班的主讲教师：作业、批改、延期、成绩册、讨论。 |
| `demo.student1`、`demo.student2` | 学生门户 | 有历史的学生：本学期已选课，一份已批改和一份未批改的作业，一个临近的截止日期，一条待处理申请，一个还在复评窗口内的成绩，消息，一份成绩单。学生 1 用旧版培养方案，学生 2 用新版。 |
| `demo.operator` | 平台控制台 | 平台运营：公司、功能开关、使用情况与配额、登录与安全设置、定时任务、公告。 |
| `rv.admin`、`rv.registrar`、`rv.teacher`、`rv.student1`、`rv.student2` | 管理后台 / 学生门户 | 第二家公司里同样的五个角色。 |

`demo.admin` 是内置租户管理员**加上**一个只在演示公司里存在的 `demo-superuser` 角色。单独的内置管理员按设计看不到业务数据。

AI 样本里还有一批老账号（密码相同）：`ling.mgr.bj`、`peng.mgr.sh`（校区负责人）、`qing.hr.bj`（人事经理）、`wei.acad.sh`（教师）、`wei.stu.sh`（学生）、`tao.admin.bj`（租户管理员）。每个账号都对应 AI 模块样本数据里的同一个人。

> **安全提示。** 登录块把一个公开的密码和平台账号放在公开页面上。只有在不放任何真实数据、也不对你邀请之外的人开放的演示环境里，这样做才可以接受。演示脚本在 `NODE_ENV=production` 时拒绝运行，除非设置 `ALLOW_DEMO_SEED=1`。要去掉这块内容，删掉 `deploy/keycloak/themes/staredu-demo/login/theme.properties` 里 `scripts=` 那一行（或整个主题目录）。

你也可以自己给某家公司的内置 `admin` 设一个密码（仅限本地使用）：

```bash
pnpm dev:password --code hq --username admin --password '<10 位以上，含大小写字母、数字、特殊字符>'
```

## 5. 分角色该试什么

### 学生（`demo.student1`，学生门户）
- **My requests**：对作业 3 申请延期然后**撤回**；对已发布的成绩申请复评（原因至少 10 个字）。
- **My assignments**：打开作业 3，提交文字和文件（最多 10 个文件、每个 20 MB，直接传到对象存储）。迟交：24 小时内扣 10%，48 小时内 20%，72 小时内 30%，之后不给分。得分、评分项分数和评语**要等教师发布后**才会出现。
- **Course enrollment**：还有名额的开放班级、按你专业的必修/选修标签、缺失的先修课、时间冲突；**Enroll** 选课、**Drop** 退课（退课会变成"W"时页面会提醒）。
- **Degree plan**（学生 1 和 2 看到的是不同版本的培养方案）、**My grades**（学期和累计 GPA，下载非正式成绩单 PDF）、**Discussions**、**Library**、右上角的**铃铛**（消息、每个类别的设置，邮件在 Mailpit 里看）、**AI assistant**（需要 AI 模块）。

### 教师（`demo.teacher`，管理后台）
- **Sections**：只能看到自己的三个班。打开一个班：花名册、**Course materials**、**Assignments**、**Grades**、**Discussion** 页签。
- **Assignments > Homework 2 > Submissions**：没批改的作业在这里等着。逐项打分、写评语，然后**发布**一份或所有已打满分的。
- **Extensions**：给某个学生延期 1–3 天并写原因。
- **Student requests**：批准那条待处理的延期（可以改天数）。复评申请你能看、能驳回，但改已发布的成绩需要教务。
- **Grades**：设置各分组的权重（合计必须是 100%），看成绩册（没交的算 0 分），手工录入期中考分数，算总评并发布，导出 CSV。班级结课后成绩锁定。
- **Discussion**：回复、置顶、标记已解决。

### 教务（`demo.registrar`）
- **Student requests**：批准成绩复评（必须给新总评和至少 5 个字的说明；改前改后都会记录）。
- **Sections** > **Batch enrollment**：选学期、课程、专业（可再按入学年份和校区缩小），点 **Preview**，再点 **Run for real**。例外情形（超员、先修、冲突、选课窗口已关、重修）要勾选并写原因。
- **Terms、Courses、Majors**（> **Curriculum**：两个版本；**Add version** 会复制你正在看的那一版）、**Sections**、**Grading scale**、**Transcripts**（签发带编号的正式 PDF；每份都有验真页和 **Revoke** 按钮）、**Announcements**、**Dashboard**（只显示你的数据范围内的校区）。

### 一个账号看全部（`demo.admin`）
打开菜单逐个走一遍：**Roles**（建角色、勾菜单、选数据范围；模板角色的旧副本可能显示 **Update from template**）、**Accounts**（邀请、重置链接、临时密码）、**Online users**（强制下线）、**Login log / Audit log / Operation log**、**Campuses 和 Departments**、**Staff 和 Students**（人事）、**Document library**（公开、内部、机密文件夹；机密的连管理员也要先做一次有记录的自我授权）、**Transcripts**、**Student requests**、**Sections**。

### 人事经理（`qing.hr.bj`）
添加员工（邮箱重复会被拒绝并显示已有的人）、加第二个任职或**调动**（历史保留）、**离职**（立即或按计划日期，该人立刻失去后台访问权）和复职、添加学员并选校区、给已有的人加学员档案、紧急联系人、**CSV 导入导出**（先检查；重复导入不会有变化）。

### 校区负责人（`ling.mgr.bj`）
只能看到自己校区的员工、学员和班级。

### 平台运营（`demo.operator`，<http://platform.localhost:3001/>）
- 公司：开通一家新公司（管理员会在 Mailpit 里收到邀请）、**通知**计划停用、**停用**（该公司的用户被拒绝，数据保留）和**恢复**、给某家公司开关**功能**。
- **Usage & quota**：账号数和已用存储；设置上限（到上限后，新建账号返回 409、上传返回 413；不会删任何东西）。
- **Sign-in & security**：密码规则、锁定、会话时长、全员两步验证、可选的 Google 登录（只会关联已有的、邮箱一致且已验证的账号）。
- **Scheduled jobs**（启用、改计划、立即运行、看运行记录；启用 "Send assignment deadline reminders"）、**Monitoring**、平台公告（接口）。

### "为什么说它安全"之旅
1. 先用 `demo.admin` 登录，再用 `rv.admin` 登录：人员、班级和申请都不同。一家公司的令牌在另一家公司的地址上会被拒绝。
2. 用 `demo.teacher` 打不开别的教师的班；用 `demo.student1` 永远看不到别的学生的提交。
3. 角色相同但部门不同的两个账号，看到的人不同；"没有数据范围"意味着没有数据，而不是全部。
4. 在 **Online users** 里强制某个用户下线：即使他的登录令牌还能有效几分钟，他的下一个请求也会被拒绝。
5. 打开一份成绩单的验真页（**Transcripts** > *Verification page*）：有效的一份和已作废的一份。

## 6. 重置与常见问题

```bash
pnpm demo:reset     # 重建演示公司的数据（日期刷新）
make reset          # 删除本模块的全部本地数据（不含 AI 模块）；然后重做第 2、3 节
```

| 现象 | 处理 |
|---|---|
| `*.localhost` 打不开 | 把三个名字加到 `/etc/hosts`，指向 `127.0.0.1`。 |
| 登录页上没有演示账号 | Keycloak 是在挂载主题之前启动的：再运行一次 `make up`，然后 `pnpm seed:demo`。 |
| 菜单能看到，页面却提示 "Missing permission"（从旧版本升级后） | 运行 `pnpm seed`：它会补上缺的菜单并刷新权限缓存。你早先复制的角色，用 **Roles > Update from template**。 |
| 在管理后台登录后显示 "No access" | 这个账号没有管理后台权限（学生和部分演示员工账号只用门户）。换 `demo.admin`。 |
| 租户管理员的列表里 "Nothing here" | 按设计，管理员没有业务数据范围；用 `demo.admin` 或 `demo.registrar`。 |
| 截止日期看起来很旧 | `pnpm demo:reset`。 |
| 端口被占用 | AI 模块用的是另外的端口（3000、5432、6379、8080）。检查第 1 节里的端口有没有被别的程序占用。 |
| 接口启动报 "Invalid environment" | 用 `pnpm dev:api` 启动（它会加载 `.env`），并确认 `.env` 存在。 |

## 7. 可选的扩展

### 业务模式下的 AI 助手
AI 模块（`../ai-module/`）平时在它自己的样本公司上运行。要让它根据本模块的数据回答：

1. 在 `business-module/.env` 里设置 `INTERNAL_API_KEY=<一个密钥>`，重启 `pnpm dev:api`，并重新建公司（`pnpm demo:reset`），因为之前开通的公司没有 `ai` 登录客户端。
2. 在 `ai-module/.env` 里设置 `STARIT_IDENTITY_MODE=business`、`STARIT_OIDC_TENANT_ISSUER_BASE=http://localhost:8180/realms`、`STARIT_BUSINESS_INTERNAL_KEY=<同一个密钥>`、`STARIT_CORS_ORIGINS=http://hq.localhost:3000`（见 `ai-module/.env.example`），然后 `make migrate` 并启动 AI 模块（需要大模型 API 密钥）。
3. 以 `demo.teacher` 或 `demo.student1` 登录，点 **AI assistant**。学生问"所有学生的成绩"，只会得到自己的。

### Kafka 事件总线
上面的内容都不需要 Kafka。想看效果：`make biz-up-kafka`，在 `.env` 里设置 `BIZ_EVENT_BUS=kafka`，重启 `pnpm dev:api`，然后做一件会发通知的事（比如以教务身份给学生选课）。事件会走：发件箱表 → Kafka 主题 `business.events` → 消费组 → 铃铛。用 `make biz-down-kafka` 停掉 Kafka 继续操作：事件会留在表里，等 Kafka 起来后补发。`make test-events` 用真实的 Kafka 跑测试。

### 直接调用接口
登录后，在浏览器开发者控制台里：

```js
const call = (path, method = "GET", body) =>
  fetch("/bff/" + path, { method, headers: { "x-requested-with": "staredu", "content-type": "application/json" }, body: body && JSON.stringify(body) }).then((r) => r.json());
await call("roles");              // 角色列表
await call("roles/menu-tree");    // 你能勾选的菜单和按钮
```

接口文档在 <http://localhost:4000/api-docs>（仅开发环境；页面本身没有登录，不要对外暴露）。

### 搭一个公开试用站

想把演示放到服务器上让别人试用，打开试用保护并安排每天重置。访客仍然可以新建、编辑、删除几乎所有内容；只有新建账号、改登录方式、平台的公司管理这几类被关掉，数据每天重建一次。配置、代理规则和定时任务文件见 [`deploy/trial/`](deploy/trial/README.md)（英文）。

### 生成你自己的资源
`pnpm gen:module --name warehouse-item --group edu --fields "title:string!,qty:int,due:date,done:bool,notes:text" --label "Warehouse items" --label-zh "仓库物品"`，然后 `pnpm migrate && pnpm prisma:generate && pnpm --filter @staredu/shared build`。它会生成表（带行级安全）、接口、权限、菜单、页面、测试和泄露扫描登记；加 `--dry-run` 只列出文件、不写入。

### 检查
```bash
pnpm lint && pnpm typecheck && pnpm test   # 需要 make up 起的 Docker 服务
pnpm test:leak                             # 只跑跨租户泄露扫描
```
