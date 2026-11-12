import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { MENU_CATALOG } from "@staredu/shared";

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

  it("every directory and menu in the platform menu catalog has a label in both languages", () => {
    for (const item of MENU_CATALOG.filter((m) => m.type !== "button")) {
      const key = item.nameKey.replace(/^menu\./, "");
      expect((en.menu as Record<string, string>)[key], `en ${item.nameKey}`).toBeTruthy();
      expect((zh.menu as Record<string, string>)[key], `zh ${item.nameKey}`).toBeTruthy();
    }
  });
});
