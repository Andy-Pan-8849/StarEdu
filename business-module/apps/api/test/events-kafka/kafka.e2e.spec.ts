// 真实 Kafka 的测试（pnpm test:events，需要 make biz-up-kafka 起好的 Kafka 容器）：
// 出站箱 → 转发器 → Kafka → 消费组 → 通知；重复投递、分区键与顺序、Kafka 停掉再恢复、死信主题。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { KafkaJS } from "@confluentinc/kafka-javascript";
import { kafkaConfig } from "../../src/events/event-bus";
import { EventConsumers } from "../../src/events/event-consumers";
import { toEnvelope } from "../../src/events/envelope";
import { KafkaService } from "../../src/events/kafka.service";
import { OutboxRelay } from "../../src/events/outbox-relay";
import { EVENT_HANDLERS } from "../../src/notify/events";
import { Harness, type TestUser } from "../helpers/app";

// 每次运行用自己的主题和消费组，不被以前的运行留下的消息干扰
const RUN = randomUUID().slice(0, 8);
process.env.BIZ_EVENT_BUS = "kafka";
process.env.KAFKA_TOPIC_PREFIX = `t${RUN}.`;
process.env.KAFKA_GROUP_PREFIX = `g${RUN}`;

const iso = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | false | null | undefined> | T | false | null | undefined, ms = 30_000, what = "condition"): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}
const businessRoot = resolve(__dirname, "../../../..");
const composeFiles = ["-f", "deploy/compose/biz.yaml", "-f", "deploy/compose/kafka.yaml"];
const envFile = existsSync(resolve(businessRoot, ".env")) ? ".env" : ".env.example";
const compose = (...args: string[]) => execFileSync("docker", ["compose", "--env-file", envFile, ...composeFiles, ...args], { cwd: businessRoot, stdio: "pipe" });

describe("Kafka event bus (real broker)", () => {
  const h = new Harness();
  let relay: OutboxRelay;
  let consumers: EventConsumers;
  let kafka: KafkaService;
  let sec: string;
  let reg: string;
  let teacher1: TestUser;
  const stu: Record<string, TestUser> = {};
  const registrar = () => h.call(reg);
  const cfg = kafkaConfig();
  const notificationsOf = (n: string, type?: string) => h.owner.notification.findMany({ where: { accountId: stu[n].accountId, ...(type ? { type } : {}) } });

  /** 读主题里的全部消息（用一次性的消费组，从头读）。 */
  async function readAll(topic: string, wanted: (m: { key: string; value: Record<string, unknown>; partition: number }) => boolean, count: number) {
    const consumer = new KafkaJS.Kafka({ kafkaJS: { brokers: cfg.brokers, clientId: "test-reader" } }).consumer({ kafkaJS: { groupId: `reader-${randomUUID()}`, fromBeginning: true } });
    await consumer.connect();
    await consumer.subscribe({ topics: [topic] });
    const got: Array<{ key: string; value: Record<string, unknown>; partition: number }> = [];
    await consumer.run({
      eachMessage: async ({ partition, message }) => {
        const m = { key: message.key?.toString() ?? "", value: JSON.parse(message.value?.toString() ?? "{}") as Record<string, unknown>, partition };
        if (wanted(m)) got.push(m);
      },
    });
    try {
      await until(() => got.length >= count, 30_000, `${count} messages in ${topic}`);
    } finally {
      await consumer.disconnect();
    }
    return got;
  }

  async function mkEnrollEvents(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = await h.owner.outboxEvent.create({ data: { tenantId: h.tenant.tenantId, type: "enrollment.registrar_added", payload: { enrollmentId: randomUUID(), studentPersonId: stu.stu2.personId, sectionId: sec } } });
      ids.push(r.id);
    }
    return ids;
  }

  beforeAll(async () => {
    await h.start();
    relay = h.app.get(OutboxRelay);
    consumers = h.app.get(EventConsumers);
    kafka = h.app.get(KafkaService);
    const campus = await h.owner.campus.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, type: "hq" } });
    reg = await (await h.user("registrar", { roles: ["academic-manager"], person: "staff", deptIds: [campus.deptId] })).token();
    teacher1 = await h.user("teacher.one", { roles: ["teacher"], person: "staff", deptIds: [campus.deptId] });
    for (const n of ["stu1", "stu2"]) stu[n] = await h.user(n, { roles: ["student"], person: "student" });
    const termId = (await registrar().post("/api/terms", { code: "2026F", name: "2026 Fall", startDate: iso(-10), endDate: iso(80), enrollOpenDate: iso(-5), enrollCloseDate: iso(10), dropDeadline: iso(20) })).body.id;
    await registrar().post(`/api/terms/${termId}/status`, { status: "enrolling" });
    const course = (await registrar().post("/api/courses", { code: "CS800", name: "Streams", credits: 3 })).body.id;
    sec = (await registrar().post("/api/sections", { courseId: course, termId, campusId: campus.id, number: "01", capacity: 20, schedule: [] })).body.id;
    await registrar().put(`/api/sections/${sec}/instructors`, { items: [{ personId: teacher1.personId, role: "lead" }] });
    await registrar().post(`/api/sections/${sec}/status`, { status: "open" });
    await kafka.ensureTopics();
    await consumers.start();
  }, 120_000);
  afterAll(async () => {
    await h.stop();
  });

  it("an enrollment by the registrar travels outbox → Kafka → consumer group → in-app message", async () => {
    await registrar().post(`/api/sections/${sec}/enrollments`, { studentIds: [stu.stu1.personId] });
    expect(await relay.tick()).toBeGreaterThan(0);
    const n = await until(async () => (await notificationsOf("stu1", "enrollment.registrar_added"))[0], 30_000, "the notification");
    expect(n.category).toBe("enrollment");
    // 审计事件在请求结束后才写入出站箱：多转发几轮，最后全部清空
    await until(async () => (await relay.tick()) >= 0 && (await h.owner.outboxEvent.count({ where: { tenantId: h.tenant.tenantId, processedAt: null, failedAt: null } })) === 0, 30_000, "the outbox to drain");
  });

  it("the same event delivered twice produces one message (event id + recipient is unique)", async () => {
    const evt = await h.owner.outboxEvent.create({ data: { tenantId: h.tenant.tenantId, type: "enrollment.registrar_removed", payload: { enrollmentId: randomUUID(), studentPersonId: stu.stu1.personId, sectionId: sec, status: "voided" } } });
    const envelope = toEnvelope(evt);
    await kafka.publishEvent(cfg.topics.business, envelope);
    await kafka.publishEvent(cfg.topics.business, envelope);
    await until(async () => (await h.owner.notification.count({ where: { dedupeKey: evt.id } })) >= 1, 30_000, "first delivery");
    await sleep(1500); // 给第二条一点时间
    expect(await h.owner.notification.count({ where: { dedupeKey: evt.id } })).toBe(1);
  });

  it("events of one aggregate share a partition and are handled in the order they were sent; the partition key spreads other aggregates", async () => {
    const seen: string[] = [];
    EVENT_HANDLERS["test.order"] = async (_db, e) => {
      seen.push(String((e.payload as { n: number }).n));
      return { items: [] };
    };
    const base = Date.now();
    for (let i = 0; i < 30; i++) await h.owner.outboxEvent.create({ data: { tenantId: h.tenant.tenantId, type: "test.order", payload: { sectionId: "order-agg", n: i }, createdAt: new Date(base + i) } });
    for (let k = 0; k < 12; k++) await h.owner.outboxEvent.create({ data: { tenantId: h.tenant.tenantId, type: "test.order", payload: { sectionId: `other-${k}`, n: 1000 + k }, createdAt: new Date(base + 100 + k) } });
    while ((await relay.tick()) > 0);
    await until(() => seen.length >= 42, 30_000, "42 events handled");
    expect(seen.filter((n) => Number(n) < 1000)).toEqual(Array.from({ length: 30 }, (_, i) => String(i)));
    const msgs = await readAll(cfg.topics.business, (m) => m.value.type === "test.order", 42);
    const partitionOf = (key: string) => new Set(msgs.filter((m) => m.key === key).map((m) => m.partition));
    expect(partitionOf(`${h.tenant.tenantId}:test:order-agg`).size).toBe(1);
    expect(new Set(msgs.map((m) => m.partition)).size).toBeGreaterThan(1);
    delete EVENT_HANDLERS["test.order"];
  });

  it("a poison event goes to the dead-letter topic with its failure reason; the events behind it are still handled", async () => {
    EVENT_HANDLERS["test.poison"] = async () => {
      throw new Error("cannot handle this one");
    };
    const poison = await h.owner.outboxEvent.create({ data: { tenantId: h.tenant.tenantId, type: "test.poison", payload: { sectionId: "dlq-agg" } } });
    await registrar().post(`/api/sections/${sec}/enrollments`, { studentIds: [stu.stu2.personId] }); // 排在毒事件后面的正常事件
    while ((await relay.tick()) > 0);
    const dead = await readAll(cfg.topics.businessDlq, (m) => (m.value.event as { id?: string } | undefined)?.id === poison.id, 1);
    expect(dead[0].value).toMatchObject({ error: "cannot handle this one", attempts: 3, event: { id: poison.id, type: "test.poison", tenantId: h.tenant.tenantId }, source: { topic: cfg.topics.business } });
    await until(async () => (await notificationsOf("stu2", "enrollment.registrar_added")).length >= 1, 30_000, "the event behind the poison one");
    delete EVENT_HANDLERS["test.poison"];
  }, 90_000);

  it("a message that is not an event envelope also goes to the dead-letter topic", async () => {
    await kafka.publish(cfg.topics.business, `${h.tenant.tenantId}:garbage`, { hello: "world" });
    const dead = await readAll(cfg.topics.businessDlq, (m) => m.value.error === "not an event envelope", 1);
    expect(dead[0].value.source).toMatchObject({ topic: cfg.topics.business });
  }, 60_000);

  it("while Kafka is stopped nothing is lost: business writes succeed, events wait in the outbox, and after the restart every one arrives exactly once", async () => {
    const before = (await notificationsOf("stu2", "enrollment.registrar_added")).length;
    compose("stop", "kafka");
    try {
      const ids = await mkEnrollEvents(5); // 业务写入不受影响
      expect(await relay.tick()).toBe(0);
      const waiting = await h.owner.outboxEvent.findMany({ where: { id: { in: ids } } });
      expect(waiting.every((e) => e.processedAt === null && e.failedAt === null)).toBe(true);
      expect(waiting.some((e) => e.lastError)).toBe(true);
    } finally {
      compose("start", "kafka");
    }
    await until(async () => (await relay.tick()) >= 0 && (await h.owner.outboxEvent.count({ where: { tenantId: h.tenant.tenantId, processedAt: null, failedAt: null } })) === 0, 90_000, "the outbox to drain after the restart");
    await until(async () => (await notificationsOf("stu2", "enrollment.registrar_added")).length >= before + 5, 60_000, "5 messages");
    await sleep(1500);
    expect((await notificationsOf("stu2", "enrollment.registrar_added")).length).toBe(before + 5); // 不多不少
  }, 240_000);
});
