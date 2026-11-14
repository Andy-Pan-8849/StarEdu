// 通知：出站箱 → 消息（幂等、失败重试、多实例抢活）、邮件（中英文、Mailpit、退订）、偏好、消息中心、
// WebSocket（票据、多实例推送、补拉）、公告（范围、阅读名单、撤回）、截止提醒、平台横幅。
import type { AddressInfo } from "node:net";
import Redis from "ioredis";
import { WebSocket } from "ws";
import { MailService } from "../../src/mail/mail.service";
import { EVENT_HANDLERS } from "../../src/notify/events";
import { NotificationService } from "../../src/notify/notification.service";
import { NotifyWorker } from "../../src/notify/notify-worker";
import { signUnsubscribe } from "../../src/notify/notification.service";
import { Harness, type TestUser } from "../helpers/app";
import { PLATFORM_HOST, PlatformFixture, platformCall } from "../helpers/platform";

const iso = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const MAILPIT = process.env.MAILPIT_API_URL ?? "http://localhost:8125";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 等到发给这个地址、主题含 subjectPart 的邮件出现（Mailpit 收信有一点延迟）。 */
async function mailsTo(address: string, subjectPart = ""): Promise<Array<{ ID: string; Subject: string }>> {
  for (let i = 0; i < 30; i++) {
    const list = (await (await fetch(`${MAILPIT}/api/v1/messages?limit=200`)).json()) as { messages: Array<{ ID: string; To: Array<{ Address: string }>; Subject: string }> };
    const mine = list.messages.filter((m) => m.To.some((t) => t.Address === address));
    if (mine.some((m) => m.Subject.includes(subjectPart))) return mine;
    await sleep(300);
  }
  return [];
}
const mailBody = async (id: string) => ((await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as { Text: string; Headers?: Record<string, string[]> });

describe("notifications", () => {
  const h = new Harness();
  let worker: NotifyWorker;
  let notify: NotificationService;
  let hqCampus: string;
  let hqDept: string;
  let termId: string;
  let sec: string;
  let boss: string;
  let reg: string;
  let t1: string;
  let t2: string;
  let teacher1: TestUser;
  const stu: Record<string, { u: TestUser; token: string }> = {};
  const as = (n: string) => h.call(stu[n].token);
  const pid = (n: string) => stu[n].u.personId as string;
  const registrar = () => h.call(reg);
  const teacher = () => h.call(t1);
  const other = () => h.call(t2);
  const mine = async (n: string) => (await as(n).get("/api/portal/notifications")).body as { unread: number; items: Array<{ id: string; title: string; body: string; category: string; readAt: string | null }> };

  async function student(name: string, email?: string) {
    const u = await h.user(name, { roles: ["student"], person: "student" });
    if (email) await h.owner.account.update({ where: { id: u.accountId }, data: { email } });
    stu[name] = { u, token: await u.token() };
  }
  async function mkSection(courseId: string, number: string, students: string[], campusId = hqCampus) {
    const id = (await registrar().post("/api/sections", { courseId, termId, campusId, number, capacity: 20, schedule: [] })).body.id as string;
    await registrar().put(`/api/sections/${id}/instructors`, { items: [{ personId: teacher1.personId, role: "lead" }] });
    await registrar().post(`/api/sections/${id}/status`, { status: "open" });
    if (students.length) await registrar().post(`/api/sections/${id}/enrollments`, { studentIds: students.map(pid) });
    return id;
  }

  beforeAll(async () => {
    await h.start();
    worker = h.app.get(NotifyWorker);
    notify = h.app.get(NotificationService);
    boss = await (await h.user("boss", { roles: ["tenant-admin"], person: "staff" })).token();
    const campus = await h.owner.campus.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, type: "hq" } });
    hqCampus = campus.id;
    hqDept = campus.deptId;
    reg = await (await h.user("registrar", { roles: ["academic-manager"], person: "staff", deptIds: [hqDept] })).token();
    teacher1 = await h.user("teacher.one", { roles: ["teacher"], person: "staff", deptIds: [hqDept] });
    t1 = await teacher1.token();
    t2 = await (await h.user("teacher.two", { roles: ["teacher"], person: "staff", deptIds: [hqDept] })).token();
    await student("stu1", "stu1@example.test");
    await student("stu2", "stu2@example.test");
    await student("stu3");
    termId = (await registrar().post("/api/terms", { code: "2026F", name: "2026 Fall", startDate: iso(-10), endDate: iso(80), enrollOpenDate: iso(-5), enrollCloseDate: iso(10), dropDeadline: iso(20) })).body.id;
    await registrar().post(`/api/terms/${termId}/status`, { status: "enrolling" });
    const c1 = (await registrar().post("/api/courses", { code: "CS501", name: "Networks", credits: 3 })).body.id;
    sec = await mkSection(c1, "01", ["stu1", "stu2"]);
  });
  afterAll(() => h.stop());

  describe("events become messages", () => {
    it("a registrar enrollment event is turned into an in-app message for the student, in English or Chinese", async () => {
      await registrar().post(`/api/sections/${sec}/enrollments`, { studentIds: [pid("stu3")] });
      expect((await worker.tick()).events).toBeGreaterThan(0);
      const n = (await mine("stu3")).items;
      expect(n).toHaveLength(1);
      expect(n[0]).toMatchObject({ category: "enrollment", title: expect.stringContaining("You were enrolled in CS501-01") });
      const zh = await as("stu3").get("/api/portal/notifications").set("Accept-Language", "zh-CN");
      expect(zh.body.items[0].title).toBe(`你已被选入 ${n[0].title.replace("You were enrolled in ", "")}`);
      // 账号上存了语言，就不再看请求头
      await as("stu3").put("/api/portal/notifications/preferences", { locale: "en" });
      expect((await as("stu3").get("/api/portal/notifications").set("Accept-Language", "zh-CN")).body.items[0].title).toMatch(/^You were enrolled/);
    });

    it("delivering the same event again does not create a second message (event id + recipient is unique)", async () => {
      const events = await h.owner.outboxEvent.findMany({ where: { tenantId: h.tenant.tenantId, type: "enrollment.registrar_added" } });
      const evt = events.find((e) => (e.payload as { studentPersonId: string }).studentPersonId === pid("stu3"))!;
      await h.owner.outboxEvent.update({ where: { id: evt.id }, data: { processedAt: null } });
      await worker.tick();
      expect(await h.owner.notification.count({ where: { accountId: stu.stu3.u.accountId, dedupeKey: evt.id } })).toBe(1);
      expect((await h.owner.outboxEvent.findUniqueOrThrow({ where: { id: evt.id } })).processedAt).not.toBeNull();
    });

    it("an event that fails is retried up to five times, then given up with the reason kept", async () => {
      EVENT_HANDLERS["test.boom"] = async () => {
        throw new Error("boom");
      };
      const evt = await h.owner.outboxEvent.create({ data: { tenantId: h.tenant.tenantId, type: "test.boom", payload: {} } });
      for (let i = 0; i < 7; i++) await worker.tick();
      const row = await h.owner.outboxEvent.findUniqueOrThrow({ where: { id: evt.id } });
      expect(row).toMatchObject({ attempts: 5, lastError: "boom", processedAt: null });
      expect(row.failedAt).not.toBeNull();
      delete EVENT_HANDLERS["test.boom"];
    });

    it("two workers at the same time share the events: each event is handled exactly once (FOR UPDATE SKIP LOCKED)", async () => {
      const seen: string[] = [];
      EVENT_HANDLERS["test.count"] = async (_db, evt) => {
        seen.push(evt.id);
        await sleep(20);
        return { items: [] };
      };
      const ids = [];
      for (let i = 0; i < 20; i++) ids.push((await h.owner.outboxEvent.create({ data: { tenantId: h.tenant.tenantId, type: "test.count", payload: {} } })).id);
      const [a, b] = await Promise.all([worker.processOutbox(10), worker.processOutbox(10)]);
      expect(a + b).toBe(20);
      expect([...seen].sort()).toEqual([...ids].sort());
      expect(await h.owner.outboxEvent.count({ where: { id: { in: ids }, processedAt: null } })).toBe(0);
      delete EVENT_HANDLERS["test.count"];
    });
  });

  describe("e-mail", () => {
    it("sends the e-mail in the account's language with an unsubscribe link; unsubscribing stops that category", async () => {
      await h.owner.account.update({ where: { id: stu.stu1.u.accountId }, data: { locale: "zh" } });
      const assignmentId = (await teacher().post(`/api/sections/${sec}/assignments`, { title: "Lab 1", dueDate: iso(5), rubric: [{ title: "Work", maxPoints: 10 }] })).body.id;
      await teacher().post(`/api/sections/${sec}/assignments/${assignmentId}/publish`, { published: true });
      await worker.tick();
      const mails = await mailsTo("stu1@example.test", "新作业");
      expect(mails.length).toBeGreaterThan(0);
      const zh = mails.find((m) => m.Subject.includes("新作业"));
      expect(zh).toBeTruthy();
      const body = await mailBody(zh!.ID);
      expect(zh!.Subject).toContain("Lab 1");
      expect(body.Text).toContain("不再接收“assignment”类邮件");
      const en = (await mailsTo("stu2@example.test", "New assignment: Lab 1")).find((m) => m.Subject.includes("New assignment: Lab 1"));
      expect(en).toBeTruthy();
      const link = /(http:\/\/[^\s]+\/api\/unsubscribe\?token=[^\s]+)/.exec(body.Text)![1];
      const token = new URL(link).searchParams.get("token")!;
      // 退订链接不用登录
      const res = await h.call(null).get(`/api/unsubscribe?token=${token}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain("assignment");
      expect((await h.call(null).get(`/api/unsubscribe?token=${token}`)).status).toBe(200); // 重复点击一样
      expect(await h.owner.notificationPreference.findFirst({ where: { accountId: stu.stu1.u.accountId, category: "assignment" } })).toMatchObject({ email: false, inApp: true });
      // 之后同类的消息只有站内，没有邮件
      const second = (await teacher().post(`/api/sections/${sec}/assignments`, { title: "Lab 2", dueDate: iso(6), rubric: [{ title: "Work", maxPoints: 10 }] })).body.id;
      await teacher().post(`/api/sections/${sec}/assignments/${second}/publish`, { published: true });
      await worker.tick();
      const n = await h.owner.notification.findFirstOrThrow({ where: { accountId: stu.stu1.u.accountId, category: "assignment" }, orderBy: { createdAt: "desc" } });
      expect(n).toMatchObject({ inApp: true, emailStatus: "none" });
    });

    it("rejects an unsubscribe link that is forged, damaged, or from another company", async () => {
      expect((await h.call(null).get("/api/unsubscribe?token=garbage")).status).toBe(400);
      expect((await h.call(null).get("/api/unsubscribe")).status).toBe(400);
      const forged = signUnsubscribe(h.tenant.tenantId, stu.stu2.u.accountId, "assignment").replace(/.$/, "x");
      expect((await h.call(null).get(`/api/unsubscribe?token=${forged}`)).status).toBe(400);
      const foreign = signUnsubscribe("11111111-1111-4111-8111-111111111111", stu.stu2.u.accountId, "assignment");
      expect((await h.call(null).get(`/api/unsubscribe?token=${foreign}`)).status).toBe(400);
      expect(await h.owner.notificationPreference.count({ where: { accountId: stu.stu2.u.accountId } })).toBe(0);
    });

    it("a failing mail server leaves the mail queued; after five tries it is marked failed", async () => {
      const spy = jest.spyOn(h.app.get(MailService), "send").mockRejectedValue(new Error("smtp down"));
      const n = await h.owner.notification.create({ data: { tenantId: h.tenant.tenantId, accountId: stu.stu2.u.accountId, category: "grade", type: "final_grade.published", params: { section: "X" }, dedupeKey: "mail-fail", emailStatus: "pending" } });
      for (let i = 0; i < 5; i++) await worker.sendEmails();
      expect(await h.owner.notification.findUniqueOrThrow({ where: { id: n.id } })).toMatchObject({ emailStatus: "failed", emailAttempts: 5 });
      spy.mockRestore();
    });
  });

  describe("inbox and preferences", () => {
    it("lists newest first, counts unread, marks read, and only ever touches the caller's own messages", async () => {
      const before = await mine("stu2");
      expect(before.unread).toBeGreaterThan(0);
      const id = before.items[0].id;
      expect((await as("stu1").post("/api/portal/notifications/read", { ids: [id] })).body.marked).toBe(0); // 别人的消息
      expect((await as("stu2").post("/api/portal/notifications/read", { ids: [id] })).body.marked).toBe(1);
      expect((await mine("stu2")).unread).toBe(before.unread - 1);
      expect((await as("stu2").post("/api/portal/notifications/read", {})).status).toBe(400);
      expect((await as("stu2").post("/api/portal/notifications/read", { all: true })).status).toBe(201);
      expect((await mine("stu2")).unread).toBe(0);
      expect((await as("stu2").get("/api/portal/notifications?unread=1")).body.items).toEqual([]);
      expect((await as("stu2").get("/api/portal/notifications?after=not-a-date")).status).toBe(400);
      // 管理后台那一套接口同样可用
      expect((await teacher().get("/api/notifications")).status).toBe(200);
    });

    it("turning a category off in-app hides it from the inbox; turning both off creates nothing", async () => {
      const put = (prefs: object[]) => as("stu2").put("/api/portal/notifications/preferences", { prefs });
      expect((await put([{ category: "grade", inApp: false, email: true }])).status).toBe(200);
      const sentBefore = await mine("stu2");
      await notify.deliver(h.tenant.tenantId, "grade", [{ accountId: stu.stu2.u.accountId, type: "final_grade.published", params: { section: "Hidden" } }], "pref-1");
      expect((await mine("stu2")).items.length).toBe(sentBefore.items.length); // 站内没出现
      expect(await h.owner.notification.findFirst({ where: { accountId: stu.stu2.u.accountId, dedupeKey: "pref-1" } })).toMatchObject({ inApp: false, emailStatus: "pending" });
      expect((await put([{ category: "grade", inApp: false, email: false }])).status).toBe(200);
      expect(await notify.deliver(h.tenant.tenantId, "grade", [{ accountId: stu.stu2.u.accountId, type: "final_grade.published", params: {} }], "pref-2")).toBe(0);
      const prefs = (await as("stu2").get("/api/portal/notifications/preferences")).body;
      expect(prefs.categories.find((c: { category: string }) => c.category === "grade")).toEqual({ category: "grade", inApp: false, email: false });
      expect(prefs.categories.find((c: { category: string }) => c.category === "enrollment")).toEqual({ category: "enrollment", inApp: true, email: true });
      expect((await put([{ category: "nonsense", inApp: true, email: true }])).status).toBe(400);
    });
  });

  describe("real-time push", () => {
    let port: number;
    let account: string;
    const connect = (ticket: string, opts: { host?: string; origin?: string } = {}) =>
      new Promise<{ ws: WebSocket; messages: Array<Record<string, unknown>> }>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}`, { headers: { Host: opts.host ?? `${h.tenant.code}.localhost`, Origin: opts.origin ?? `http://${h.tenant.code}.localhost:3001` } });
        const messages: Array<Record<string, unknown>> = [];
        ws.on("message", (d) => messages.push(JSON.parse(String(d))));
        ws.on("open", () => resolve({ ws, messages }));
        ws.on("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
        ws.on("error", reject);
      });
    const ticket = async (who = "stu1") => (await as(who).post("/api/portal/notifications/ws-ticket")).body.ticket as string;
    const waitFor = async (cond: () => boolean) => {
      for (let i = 0; i < 40 && !cond(); i++) await sleep(50);
      return cond();
    };

    beforeAll(async () => {
      await h.app.listen(0);
      port = (h.app.getHttpServer().address() as AddressInfo).port;
      account = stu.stu1.u.accountId;
    });

    it("a ticket works once; the connection receives a push for a new message, and a message sent by another instance through Redis", async () => {
      const t = await ticket();
      const { ws, messages } = await connect(t);
      expect(await waitFor(() => messages.some((m) => m.event === "ready"))).toBe(true);
      await expect(connect(t)).rejects.toThrow(/401/); // 票据只能用一次
      await notify.deliver(h.tenant.tenantId, "grade", [{ accountId: account, type: "final_grade.published", params: { section: "Live" } }], "live-1");
      expect(await waitFor(() => messages.some((m) => m.event === "notification"))).toBe(true);
      const other = new Redis(process.env.REDIS_URL as string); // 另一个 API 实例发布的
      await other.publish("notify", JSON.stringify({ tenantId: h.tenant.tenantId, accountId: account, id: "from-other-instance" }));
      expect(await waitFor(() => messages.some((m) => m.id === "from-other-instance"))).toBe(true);
      other.disconnect();
      ws.close();
    });

    it("after a disconnect the missed messages are fetched with ?after=", async () => {
      const marker = new Date(Date.now() - 1).toISOString();
      await notify.deliver(h.tenant.tenantId, "grade", [{ accountId: account, type: "final_grade.published", params: { section: "While offline" } }], "offline-1");
      const missed = (await as("stu1").get(`/api/portal/notifications?after=${encodeURIComponent(marker)}`)).body.items;
      expect(missed.map((m: { title: string }) => m.title).join(" ")).toContain("While offline");
    });

    it("refuses a connection without a valid ticket, from another company's host, or from a foreign page", async () => {
      await expect(connect("0".repeat(48))).rejects.toThrow(/401/);
      await expect(connect("not-a-ticket")).rejects.toThrow(/401/);
      const t = await ticket();
      await expect(connect(t, { host: "other-company.localhost" })).rejects.toThrow(/403/);
      await expect(connect(await ticket(), { origin: "http://evil.example.test" })).rejects.toThrow(/403/);
    });

    it("a connection only gets its own account's messages", async () => {
      const a = await connect(await ticket("stu1"));
      const b = await connect(await ticket("stu3"));
      await notify.deliver(h.tenant.tenantId, "grade", [{ accountId: stu.stu3.u.accountId, type: "final_grade.published", params: { section: "Only for three" } }], "private-1");
      expect(await waitFor(() => b.messages.some((m) => m.event === "notification"))).toBe(true);
      await sleep(200);
      expect(a.messages.filter((m) => m.event === "notification" && m.id !== "from-other-instance" && JSON.stringify(m).includes("private")).length).toBe(0);
      a.ws.close();
      b.ws.close();
    });
  });

  describe("announcements", () => {
    it("the registrar (all-data scope) announces to the whole company; every active account gets a message; a teacher cannot", async () => {
      const post = (call: () => ReturnType<typeof registrar>, target: object) => call().post("/api/announcements", { title: "Campus closed Friday", body: "Stay home.", target });
      expect((await post(teacher, { kind: "tenant" })).status).toBe(403);
      expect((await post(() => as("stu1"), { kind: "tenant" })).status).toBe(403);
      const res = await post(registrar, { kind: "tenant" });
      expect(res.status).toBe(201);
      expect(res.body.recipients).toBeGreaterThan(5);
      for (const n of ["stu1", "stu2", "stu3"]) expect((await mine(n)).items.some((i) => i.title === "Campus closed Friday" && i.category === "announcement")).toBe(true);
    });

    it("a teacher announces to their own section only; the audience is its teachers and enrolled students", async () => {
      const own = await teacher().post("/api/announcements", { title: "Bring a laptop", body: "Lab tomorrow.", target: { kind: "section", sectionId: sec } });
      expect(own.status).toBe(201);
      expect(own.body.recipients).toBe(4); // 老师 + 3 个学生
      expect((await other().post("/api/announcements", { title: "x", body: "y", target: { kind: "section", sectionId: sec } })).status).toBe(404);
      expect((await mine("stu3")).items.some((i) => i.title === "Bring a laptop")).toBe(true);
      const outsider = await student("stu4");
      void outsider;
      expect((await mine("stu4")).items.some((i) => i.title === "Bring a laptop")).toBe(false);
    });

    it("a campus announcement reaches that campus's people; a campus lead cannot announce to another campus", async () => {
      const sh = (await h.call(boss).post("/api/campuses", { code: "SH", name: "Shanghai", timezone: "Asia/Shanghai" })).body;
      const lead = await (await h.user("lead.hq", { roles: ["campus-lead"], person: "staff", deptIds: [hqDept] })).token();
      expect((await h.call(lead).post("/api/announcements", { title: "To Shanghai", body: "x", target: { kind: "campus", campusId: sh.id } })).status).toBe(403);
      const ok = await h.call(lead).post("/api/announcements", { title: "HQ notice", body: "x", target: { kind: "campus", campusId: hqCampus } });
      expect(ok.status).toBe(201);
      expect((await mine("stu1")).items.some((i) => i.title === "HQ notice")).toBe(true);
      expect((await registrar().post("/api/announcements", { title: "Empty", body: "x", target: { kind: "campus", campusId: sh.id } })).status).toBe(400); // 那个校区没有人
    });

    it("the reader list shows who has read it; withdrawing removes it from everyone's inbox", async () => {
      const a = (await registrar().post("/api/announcements", { title: "Read me", body: "x", target: { kind: "section", sectionId: sec } })).body;
      const item = (await mine("stu1")).items.find((i) => i.title === "Read me")!;
      await as("stu1").post("/api/portal/notifications/read", { ids: [item.id] });
      const readers = (await registrar().get(`/api/announcements/${a.id}/readers`)).body as Array<{ username: string; readAt: string | null }>;
      expect(readers.find((r) => r.username === "stu1")!.readAt).not.toBeNull();
      expect(readers.find((r) => r.username === "stu2")!.readAt).toBeNull();
      expect((await other().get(`/api/announcements/${a.id}/readers`)).status).toBe(404); // 别人发的
      expect((await as("stu1").get(`/api/announcements/${a.id}/readers`)).status).toBe(403);
      expect((await registrar().del(`/api/announcements/${a.id}`)).status).toBe(200);
      expect((await registrar().del(`/api/announcements/${a.id}`)).status).toBe(409);
      expect((await mine("stu1")).items.some((i) => i.title === "Read me")).toBe(false);
    });
  });

  describe("deadline reminders", () => {
    it("remind students who have not submitted, once, counting each student's own deadline (extensions included)", async () => {
      const id = (await teacher().post(`/api/sections/${sec}/assignments`, { title: "Due tomorrow", dueDate: iso(0), rubric: [{ title: "Work", maxPoints: 10 }] })).body.id;
      await teacher().post(`/api/sections/${sec}/assignments/${id}/publish`, { published: true });
      // 截止在 10 小时后；stu1 已提交；stu2 有 2 天延期（个人截止在 58 小时后，还没到提醒窗口）
      await h.owner.assignment.update({ where: { id }, data: { dueAt: new Date(Date.now() + 10 * 36e5) } });
      await as("stu1").post(`/api/portal/assignments/${id}/submissions`, { text: "done" });
      await teacher().put(`/api/sections/${sec}/assignments/${id}/extensions/${pid("stu2")}`, { days: 2, reason: "doctor's note" });
      const r1 = await notify.deadlineReminders();
      const r2 = await notify.deadlineReminders();
      expect(r1.reminded).toBe(1); // 只有 stu3
      expect(r2.reminded).toBe(0); // 不重复发
      expect((await mine("stu3")).items.some((i) => i.title === "Due soon: Due tomorrow")).toBe(true);
      expect((await mine("stu1")).items.some((i) => i.title === "Due soon: Due tomorrow")).toBe(false);
      expect((await mine("stu2")).items.some((i) => i.title === "Due soon: Due tomorrow")).toBe(false);
      // 延期的学生到了自己的窗口也会被提醒
      expect((await notify.deadlineReminders(new Date(Date.now() + 40 * 36e5))).reminded).toBe(1);
    });

    it("is registered as a scheduled job platform operators can run", async () => {
      const { JOBS } = await import("../../src/platform/jobs/job-registry");
      expect(JOBS.some((j) => j.code === "notify.deadline-reminders")).toBe(true);
    });
  });

  describe("platform announcements (banners)", () => {
    let fx: PlatformFixture;
    let root: () => ReturnType<typeof platformCall>;
    beforeAll(async () => {
      fx = new PlatformFixture(h.owner, h.keycloak);
      await fx.setup();
      const token = await (await fx.user("p.notice", { roles: ["platform-super"] })).token();
      root = () => platformCall(h.app, token);
    });
    afterAll(async () => {
      await h.owner.platformAnnouncement.deleteMany({ where: { title: { startsWith: "[test]" } } });
      await fx.cleanup();
    });

    it("the platform publishes a banner for a time window; every tenant user sees it only inside the window; tenant users cannot publish", async () => {
      const hour = 36e5;
      const create = (over: object) => root().post("/api/platform/announcements", { title: "[test] Planned maintenance", body: "Saturday 02:00", startsAt: new Date(Date.now() - hour).toISOString(), endsAt: new Date(Date.now() + hour).toISOString(), ...over });
      expect((await create({ endsAt: new Date(Date.now() - 2 * hour).toISOString() })).status).toBe(400); // 结束早于开始
      const live = await create({});
      expect(live.status).toBe(201);
      await create({ title: "[test] Expired", startsAt: new Date(Date.now() - 5 * hour).toISOString(), endsAt: new Date(Date.now() - 4 * hour).toISOString() });
      const seen = (await as("stu1").get("/api/portal/banners")).body.map((b: { title: string }) => b.title);
      expect(seen).toContain("[test] Planned maintenance");
      expect(seen).not.toContain("[test] Expired");
      expect((await teacher().get("/api/banners")).body.map((b: { title: string }) => b.title)).toContain("[test] Planned maintenance");
      expect((await h.call(boss).post("/api/platform/announcements", {})).status).toBe(403); // 租户主机上平台接口一律拒绝
      expect((await root().del(`/api/platform/announcements/${live.body.id}`)).status).toBe(200);
      expect((await as("stu1").get("/api/portal/banners")).body.map((b: { title: string }) => b.title)).not.toContain("[test] Planned maintenance");
      expect(PLATFORM_HOST).toBeTruthy();
    });
  });
});
