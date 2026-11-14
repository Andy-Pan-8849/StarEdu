// 转发器（用假的 Kafka，连真实数据库）：顺序、Kafka 不可用时事件留在表里且不丢、敏感载荷被拒绝；
// kafka 模式多发的事件类型、载荷里没有敏感信息；伪造的信封查不到别的租户的数据。
import { OutboxRelay } from "../../src/events/outbox-relay";
import { toEnvelope } from "../../src/events/envelope";
import { unsafePayload } from "../../src/events/envelope";
import { NotifyWorker } from "../../src/notify/notify-worker";
import { Harness, type TestUser } from "../helpers/app";

const iso = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

class FakeKafka {
  sent: Array<{ topic: string; key: string; id: string }> = [];
  down = false;
  async publishEvent(topic: string, e: { key: string; id: string }) {
    if (this.down) throw new Error("broker unavailable");
    this.sent.push({ topic, key: e.key, id: e.id });
  }
}

describe("event bus: outbox relay and extended events", () => {
  const h = new Harness();
  const kafka = new FakeKafka();
  let relay: OutboxRelay;
  let worker: NotifyWorker;
  const mkEvent = (type: string, payload: object, createdAt = new Date()) => h.owner.outboxEvent.create({ data: { tenantId: h.tenant.tenantId, type, payload, createdAt } });
  const pending = () => h.owner.outboxEvent.findMany({ where: { tenantId: h.tenant.tenantId, processedAt: null, failedAt: null }, orderBy: { createdAt: "asc" } });
  const clear = () => h.owner.outboxEvent.deleteMany({ where: { tenantId: h.tenant.tenantId } });

  beforeAll(async () => {
    await h.start();
    relay = new OutboxRelay(h.owner as never, kafka as never);
    worker = h.app.get(NotifyWorker);
  });
  afterAll(() => h.stop());
  afterEach(() => {
    delete process.env.BIZ_EVENT_BUS;
  });

  describe("relay", () => {
    beforeEach(async () => {
      await clear();
      kafka.sent = [];
      kafka.down = false;
    });

    it("sends events in the order they were written, with their partition key, and marks them processed only after Kafka confirms", async () => {
      const base = Date.now();
      const rows = [];
      for (let i = 0; i < 5; i++) rows.push(await mkEvent(i % 2 ? "section.cancelled" : "assignment.published", { sectionId: "sec-1", n: i }, new Date(base + i)));
      expect(await relay.tick()).toBe(5);
      expect(kafka.sent.map((s) => s.id)).toEqual(rows.map((r) => r.id));
      expect(new Set(kafka.sent.map((s) => s.key))).toEqual(new Set([`${h.tenant.tenantId}:section:sec-1`, `${h.tenant.tenantId}:assignment:sec-1`].filter((k) => kafka.sent.some((s) => s.key === k))));
      expect(await pending()).toEqual([]);
      expect(await relay.tick()).toBe(0); // 不重复发
      expect(kafka.sent[0].key).toBe(toEnvelope({ ...rows[0], payload: rows[0].payload }).key);
    });

    it("when Kafka is down the business writes still succeed, the events stay in the table, and after recovery every one is sent once and in order", async () => {
      kafka.down = true;
      const base = Date.now();
      const rows = [];
      for (let i = 0; i < 4; i++) rows.push(await mkEvent("section.cancelled", { sectionId: "sec-2", n: i }, new Date(base + i)));
      expect(await relay.tick()).toBe(0);
      const left = await pending();
      expect(left).toHaveLength(4);
      expect(left[0].lastError).toMatch(/broker unavailable/);
      expect(left.every((e) => e.processedAt === null && e.failedAt === null)).toBe(true); // 不会因为 Kafka 不可用就被放弃
      kafka.down = false;
      expect(await relay.tick()).toBe(4);
      expect(kafka.sent.map((s) => s.id)).toEqual(rows.map((r) => r.id));
      expect(await pending()).toEqual([]);
      expect((await h.owner.outboxEvent.findUniqueOrThrow({ where: { id: rows[0].id } })).lastError).toBeNull();
    });

    it("an event whose payload holds sensitive data is refused, never sent, and does not block the others", async () => {
      const bad = await mkEvent("x.leaky", { sectionId: "s", password: "hunter2" }, new Date(Date.now() - 2));
      const ok = await mkEvent("section.cancelled", { sectionId: "s" }, new Date(Date.now() - 1));
      expect(await relay.tick()).toBe(1);
      expect(kafka.sent.map((s) => s.id)).toEqual([ok.id]);
      expect(await h.owner.outboxEvent.findUniqueOrThrow({ where: { id: bad.id } })).toMatchObject({ processedAt: null, lastError: expect.stringContaining("sensitive") });
      expect((await h.owner.outboxEvent.findUniqueOrThrow({ where: { id: bad.id } })).failedAt).not.toBeNull();
    });

    it("two relays at the same time share the events: each is sent exactly once", async () => {
      for (let i = 0; i < 20; i++) await mkEvent("section.cancelled", { sectionId: `sec-${i}` });
      const other = new OutboxRelay(h.owner as never, kafka as never);
      const [a, b] = await Promise.all([relay.tick(10), other.tick(10)]);
      expect(a + b).toBe(20);
      expect(new Set(kafka.sent.map((s) => s.id)).size).toBe(20);
      expect(kafka.sent).toHaveLength(20);
    });
  });

  describe("kafka mode produces more event types, and none carries sensitive data", () => {
    let reg: string;
    let teacher1: TestUser;
    let hqCampus: string;
    let hqDept: string;
    let boss: string;
    const registrar = () => h.call(reg);

    it("enrollment, account changes and audit records become events only in kafka mode", async () => {
      await clear();
      const campus = await h.owner.campus.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, type: "hq" } });
      hqCampus = campus.id;
      hqDept = campus.deptId;
      boss = await (await h.user("boss", { roles: ["tenant-admin"], person: "staff" })).token();
      reg = await (await h.user("registrar", { roles: ["academic-manager"], person: "staff", deptIds: [hqDept] })).token();
      teacher1 = await h.user("teacher.one", { roles: ["teacher"], person: "staff", deptIds: [hqDept] });
      const stuUser = await h.user("stu.one", { roles: ["student"], person: "student" });
      const stu = await stuUser.token();
      const termId = (await registrar().post("/api/terms", { code: "2026F", name: "2026 Fall", startDate: iso(-10), endDate: iso(80), enrollOpenDate: iso(-5), enrollCloseDate: iso(10), dropDeadline: iso(20) })).body.id;
      await registrar().post(`/api/terms/${termId}/status`, { status: "enrolling" });
      const course = (await registrar().post("/api/courses", { code: "CS700", name: "Events", credits: 3 })).body.id;
      const mkSection = async (number: string) => {
        const id = (await registrar().post("/api/sections", { courseId: course, termId, campusId: hqCampus, number, capacity: 5, schedule: [] })).body.id;
        await registrar().put(`/api/sections/${id}/instructors`, { items: [{ personId: teacher1.personId, role: "lead" }] });
        await registrar().post(`/api/sections/${id}/status`, { status: "open" });
        return id;
      };
      const types = async () => (await h.owner.outboxEvent.findMany({ where: { tenantId: h.tenant.tenantId } })).map((e) => e.type);

      // 默认模式（outbox）：只有 B9 的事件，没有多发的
      const s1 = await mkSection("01");
      await h.call(stu).post("/api/portal/enrollments", { sectionId: s1 });
      expect((await h.call(boss).post("/api/accounts", { username: "someone.new", email: "someone.new@example.test" })).status).toBe(201);
      const plain = await types();
      expect(plain.filter((t) => /^(audit\.|account\.|enrollment\.(enrolled|dropped))/.test(t))).toEqual([]);

      // kafka 模式：自助选课、退课、账号变更、审计记录和操作记录都有事件
      await clear();
      process.env.BIZ_EVENT_BUS = "kafka";
      const myEnrollment = (await h.call(stu).get("/api/portal/my-enrollments")).body[0].id;
      await h.call(stu).del(`/api/portal/enrollments/${myEnrollment}`);
      await h.call(stu).post("/api/portal/enrollments", { sectionId: s1 });
      expect((await h.call(boss).post("/api/accounts", { username: "someone.else", email: "someone.else@example.test" })).status).toBe(201);
      await h.call(boss).post("/api/roles", { code: "auditor", name: "Auditor" });
      const all = await h.owner.outboxEvent.findMany({ where: { tenantId: h.tenant.tenantId } });
      const kinds = new Set(all.map((e) => e.type));
      for (const t of ["enrollment.enrolled", "enrollment.dropped", "account.changed", "audit.recorded", "audit.operation"]) expect(kinds).toContain(t);
      // 没有任何事件的载荷带敏感字段名或邮箱地址（账号的邮箱、密码、令牌都不在里面）
      for (const e of all) expect({ type: e.type, problem: unsafePayload(e.payload) }).toEqual({ type: e.type, problem: null });
      // 审计事件不带明细
      const rec = all.find((e) => e.type === "audit.recorded")!;
      expect(Object.keys(rec.payload as object).sort()).toEqual(["action", "actorAccountId", "targetId", "targetType"]);
      expect(all.find((e) => e.type === "account.changed")!.payload).toMatchObject({ change: expect.stringMatching(/^account\./) });
    });
  });

  describe("tenant isolation of event handling", () => {
    it("a forged envelope (this tenant's id, another tenant's section) cannot read the other tenant's data", async () => {
      const other = await h.extraTenant();
      const campus = await h.owner.campus.findFirstOrThrow({ where: { tenantId: other.tenantId } });
      const term = await h.owner.term.create({ data: { tenantId: other.tenantId, code: "T", name: "T", startDate: new Date(), endDate: new Date(Date.now() + 864e5) } });
      const course = await h.owner.course.create({ data: { tenantId: other.tenantId, code: "SECRET1", name: "Other tenant's course", credits: 1 } });
      const foreign = await h.owner.section.create({ data: { tenantId: other.tenantId, courseId: course.id, termId: term.id, campusId: campus.id, number: "01", name: "SECRET1-01 other tenant", capacity: 1 } });
      const mine = await h.user("victim", { roles: ["student"], person: "student" });
      await worker.handleEvent({ id: "forged-1", tenantId: h.tenant.tenantId, type: "section.cancelled", payload: { sectionId: foreign.id, studentPersonId: mine.personId } });
      const n = await h.owner.notification.findFirstOrThrow({ where: { accountId: mine.accountId, dedupeKey: "forged-1" } });
      expect(JSON.stringify(n)).not.toContain("SECRET1");
      expect(n.params).toEqual({ section: "" }); // 别的租户的班级名查不到
    });
  });
});
