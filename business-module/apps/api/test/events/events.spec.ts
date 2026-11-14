// 事件信封、分区键、载荷检查、主题、模式（纯函数，不连任何服务）。
import { busMode, extendedEvents, kafkaConfig } from "../../src/events/event-bus";
import { aggregateOf, toEnvelope, topicFor, unsafePayload } from "../../src/events/envelope";

const row = (type: string, payload: unknown, id = "evt-1") => ({ id, tenantId: "t-1", type, payload, createdAt: new Date("2026-11-13T10:00:00Z") });

describe("event envelope", () => {
  it("carries the tenant, a version, the time and a partition key of tenant + aggregate", () => {
    expect(toEnvelope(row("assignment.published", { sectionId: "s-9", assignmentId: "a-1" }))).toEqual({
      id: "evt-1", type: "assignment.published", version: 1, tenantId: "t-1", occurredAt: "2026-11-13T10:00:00.000Z", key: "t-1:assignment:s-9", payload: { sectionId: "s-9", assignmentId: "a-1" },
    });
  });

  it("events about the same section share a key (so they stay in order); different sections and tenants do not", () => {
    const key = (tenant: string, type: string, payload: object) => toEnvelope({ ...row(type, payload), tenantId: tenant }).key;
    expect(key("t", "section.cancelled", { sectionId: "s1" })).toBe("t:section:s1");
    expect(key("t", "section.cancelled", { sectionId: "s1", studentPersonId: "p1" })).toBe(key("t", "section.cancelled", { sectionId: "s1", studentPersonId: "p2" }));
    expect(key("t", "section.cancelled", { sectionId: "s1" })).not.toBe(key("t", "section.cancelled", { sectionId: "s2" }));
    expect(key("t1", "section.cancelled", { sectionId: "s1" })).not.toBe(key("t2", "section.cancelled", { sectionId: "s1" }));
  });

  it("an event without a known aggregate uses its own id (no ordering needed)", () => {
    expect(aggregateOf("x.y", { foo: 1 }, "evt-7")).toBe("evt-7");
    expect(aggregateOf("x.y", null, "evt-8")).toBe("evt-8");
  });

  it("audit events go to audit.events, everything else to business.events", () => {
    expect(topicFor("audit.recorded")).toBe(kafkaConfig().topics.audit);
    expect(topicFor("audit.operation")).toBe(kafkaConfig().topics.audit);
    expect(topicFor("final_grade.published")).toBe(kafkaConfig().topics.business);
  });

  it("refuses payloads with sensitive field names or values that look like e-mail addresses", () => {
    expect(unsafePayload({ sectionId: "s", status: "voided", overrides: ["capacity"] })).toBeNull();
    expect(unsafePayload({ password: "x" })).toMatch(/sensitive/);
    expect(unsafePayload({ nested: { apiToken: "x" } })).toMatch(/nested\.apiToken/);
    expect(unsafePayload({ idNumber: "1" })).toMatch(/sensitive/);
    expect(unsafePayload({ note: "write to a.b@example.com" })).toMatch(/e-mail/);
    expect(unsafePayload({ list: [{ phone: "1" }] })).toMatch(/list\[0\]\.phone/);
  });

  it("the default bus is the outbox; Kafka mode is opt-in and turns the extended events on", () => {
    const before = process.env.BIZ_EVENT_BUS;
    delete process.env.BIZ_EVENT_BUS;
    expect([busMode(), extendedEvents()]).toEqual(["outbox", false]);
    process.env.BIZ_EVENT_BUS = "kafka";
    expect([busMode(), extendedEvents()]).toEqual(["kafka", true]);
    process.env.BIZ_EVENT_BUS = "nonsense";
    expect(busMode()).toBe("outbox");
    if (before === undefined) delete process.env.BIZ_EVENT_BUS;
    else process.env.BIZ_EVENT_BUS = before;
  });
});
