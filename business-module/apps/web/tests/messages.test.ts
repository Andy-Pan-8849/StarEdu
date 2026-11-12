import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";

function keys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object" ? keys(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

describe("translations", () => {
  it("English and Chinese have exactly the same keys", () => {
    expect(keys(zh).sort()).toEqual(keys(en).sort());
  });

  it("no translation is empty", () => {
    for (const bundle of [en, zh]) {
      const values = JSON.stringify(bundle).match(/:\s*"([^"]*)"/g) ?? [];
      expect(values.every((v) => !/:\s*""/.test(v))).toBe(true);
    }
  });
});
