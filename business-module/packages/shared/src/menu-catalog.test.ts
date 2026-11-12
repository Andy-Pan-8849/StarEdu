import { describe, expect, it } from "vitest";
import { entriesOf, MENU_CATALOG } from "./menu-catalog";
import { PERMISSION_PATTERN, PERMS } from "./permissions";
import { BUILTIN_SCOPE_CODES, ROLE_TEMPLATES } from "./role-templates";

describe("menu catalog", () => {
  const codes = new Set(MENU_CATALOG.map((m) => m.code));

  it("has unique codes and every parent exists", () => {
    expect(codes.size).toBe(MENU_CATALOG.length);
    for (const m of MENU_CATALOG) if (m.parent) expect(codes.has(m.parent)).toBe(true);
  });

  it("lists parents before their children (so a sync can insert in order)", () => {
    const seen = new Set<string>();
    for (const m of MENU_CATALOG) {
      if (m.parent) expect(seen.has(m.parent)).toBe(true);
      seen.add(m.code);
    }
  });

  it("buttons and menus carry well-formed, unique permission codes; directories carry none", () => {
    const perms: string[] = [];
    for (const m of MENU_CATALOG) {
      if (m.type === "directory") expect(m.perms).toBeUndefined();
      if (m.type === "button") expect(m.perms).toBeDefined();
      if (m.perms) {
        expect(m.perms).toMatch(PERMISSION_PATTERN);
        perms.push(m.perms);
      }
    }
    expect(new Set(perms).size).toBe(perms.length);
  });

  it("every permission constant appears in the catalog and vice versa", () => {
    const inCatalog = new Set(MENU_CATALOG.flatMap((m) => (m.perms ? [m.perms] : [])));
    expect(new Set(Object.values(PERMS))).toEqual(inCatalog);
  });

  it("only top-level entries are assigned to an entry, and every top-level one is", () => {
    for (const m of MENU_CATALOG) {
      if (m.parent) expect(m.entries).toBeUndefined();
      else expect(entriesOf(m.code).length).toBeGreaterThan(0);
    }
    expect(entriesOf("system:role:add")).toEqual(["admin"]);
  });

  it("role templates reference real menus and built-in data scopes", () => {
    for (const t of ROLE_TEMPLATES) {
      for (const c of t.menuCodes) expect(codes.has(c)).toBe(true);
      for (const s of t.scopes) expect(BUILTIN_SCOPE_CODES).toContain(s);
    }
    expect(new Set(ROLE_TEMPLATES.map((t) => t.code)).size).toBe(ROLE_TEMPLATES.length);
  });
});
