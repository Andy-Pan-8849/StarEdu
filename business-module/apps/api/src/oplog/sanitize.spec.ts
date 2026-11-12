import { sanitize, sanitizeParams } from "./sanitize";

describe("operation log parameter sanitizing", () => {
  it("masks sensitive keys at any depth and keeps the rest", () => {
    expect(sanitize({ username: "ann", password: "p@ss", nested: { apiKey: "k", idCard: "1", token: "t", ok: 1 }, list: [{ Phone: "123" }] })).toEqual({
      username: "ann",
      password: "***",
      nested: { apiKey: "***", idCard: "***", token: "***", ok: 1 },
      list: [{ Phone: "***" }],
    });
  });
  it("truncates long strings, long arrays and deep objects", () => {
    expect((sanitize("x".repeat(1000)) as string).length).toBeLessThan(330);
    expect((sanitize(Array.from({ length: 500 }, (_, i) => i)) as number[]).length).toBe(50);
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 10; i += 1) deep = { d: deep };
    expect(JSON.stringify(sanitize(deep))).toContain("[too deep]");
  });
  it("keeps only key names when the whole thing is too large", () => {
    const body = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field${i}`, "y".repeat(250)]));
    expect(sanitizeParams({ body, query: {} })).toMatchObject({ truncated: true, bodyKeys: expect.arrayContaining(["field0"]) });
  });
  it("passes small params through", () => {
    expect(sanitizeParams({ body: { name: "A" }, query: { page: "1" } })).toEqual({ body: { name: "A" }, query: { page: "1" } });
  });
});
