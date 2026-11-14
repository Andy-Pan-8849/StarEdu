import { categoryOf, pickLocale, render, TEMPLATES, CATEGORIES } from "../../src/notify/templates";
import { readUnsubscribe, signUnsubscribe } from "../../src/notify/notification.service";

describe("notification templates", () => {
  it("every template has both languages, a known category, and uses the same placeholders in both", () => {
    for (const [type, t] of Object.entries(TEMPLATES)) {
      expect(CATEGORIES).toContain(t.category);
      const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(holes(t.en.title + t.en.body)).toEqual(holes(t.zh.title + t.zh.body));
      expect(t.en.title.length && t.zh.title.length && t.en.body.length && t.zh.body.length).toBeTruthy();
      expect(categoryOf(type)).toBe(t.category);
    }
  });
  it("fills the placeholders and picks the language: stored choice first, then the request header, then English", () => {
    expect(render("assignment.published", { title: "HW", section: "S", dueDate: "2026-01-01" }, "en").title).toBe("New assignment: HW");
    expect(render("assignment.published", { title: "HW", section: "S", dueDate: "2026-01-01" }, "zh").title).toBe("新作业：HW");
    expect(pickLocale("zh", "en-US")).toBe("zh");
    expect(pickLocale(null, "zh-CN,zh;q=0.9")).toBe("zh");
    expect(pickLocale(undefined, "fr")).toBe("en");
    expect(pickLocale(null)).toBe("en");
  });
  it("unsubscribe tokens carry the tenant, account and category, and fail when changed", () => {
    const token = signUnsubscribe("t", "a", "grade");
    expect(readUnsubscribe(token)).toEqual({ tenantId: "t", accountId: "a", category: "grade" });
    expect(readUnsubscribe(token + "x")).toBeNull();
    expect(readUnsubscribe(signUnsubscribe("t", "a", "not-a-category"))).toBeNull();
    expect(readUnsubscribe("")).toBeNull();
  });
});
