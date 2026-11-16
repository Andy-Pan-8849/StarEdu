// 每个菜单（不是目录、按钮、外链）都必须有页面：否则管理员点开就是"页面尚未提供"，演示和试用时第一印象很差。
import { MENU_CATALOG } from "@staredu/shared";
import { describe, expect, it } from "vitest";
import { PAGES } from "../src/components/admin/page-registry";

// 已知还没有页面的菜单。新增的菜单没有页面则测试失败；真有暂缓的，在这里登记并写明原因。
const KNOWN_MISSING: string[] = [];

describe("page registry", () => {
  it("has a page for every menu in the catalog, except the known gaps", () => {
    const missing = MENU_CATALOG.filter((m) => m.type === "menu").filter((m) => !m.component || !PAGES[m.component]).map((m) => m.code);
    expect(missing.sort()).toEqual(KNOWN_MISSING);
  });

  it("has no page that no menu points to", () => {
    const used = new Set(MENU_CATALOG.filter((m) => m.type === "menu").map((m) => m.component));
    const orphans = Object.keys(PAGES).filter((k) => !used.has(k));
    expect(orphans).toEqual([]);
  });
});
