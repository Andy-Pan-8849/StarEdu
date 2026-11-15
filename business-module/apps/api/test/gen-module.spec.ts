// CRUD 生成器：字段解析、命名，以及"锚点还在"——生成器要往这些文件里插入内容，文件改版后锚点丢了，这里立刻失败，
// 不用等到有人真的运行生成器。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyPatches, buildPlan, namesOf, parseFields } from "../../../scripts/lib/gen-module";

const root = resolve(__dirname, "../../..");
const opts = { name: "warehouse-item", group: "edu", fields: parseFields("title:string!,qty:int,due:date,done:bool,notes:text"), label: "Warehouse items", labelZh: "仓库物品", stamp: "20270101000000" };

describe("module generator", () => {
  it("parses fields", () => {
    expect(parseFields("title:string!,qty:int")).toEqual([{ name: "title", type: "string", required: true }, { name: "qty", type: "int", required: false }]);
    expect(() => parseFields("")).toThrow();
    expect(() => parseFields("a:float")).toThrow(/Unknown type/);
    expect(() => parseFields("Bad:string")).toThrow(/Bad field name/);
    expect(() => parseFields("tenantId:string")).toThrow(/reserved/);
    expect(() => parseFields("a:int,a:string")).toThrow(/Duplicate/);
  });

  it("derives names", () => {
    expect(namesOf(opts)).toMatchObject({ pascal: "WarehouseItem", camel: "warehouseItem", snake: "warehouse_item", plural: "warehouse-items", permPrefix: "edu:warehouseItem" });
    expect(namesOf({ ...opts, plural: "warehouse-stock" }).plural).toBe("warehouse-stock");
    expect(() => namesOf({ ...opts, name: "Bad_Name" })).toThrow();
  });

  it("every anchor exists in the real files, so the generator can be run today", () => {
    for (const e of buildPlan(opts)) {
      if (e.create !== undefined) continue;
      expect(() => applyPatches(readFileSync(join(root, e.file), "utf8"), e.patches ?? [], e.file)).not.toThrow();
    }
  });

  it("fails loudly (and changes nothing) when an anchor is missing", () => {
    expect(() => applyPatches("nothing here", [{ anchor: "needle", after: "x" }], "f.ts")).toThrow(/anchor not found/);
  });

  it("generated code covers the permissions, the leak registry and the migration's row-level security", () => {
    const files = Object.fromEntries(buildPlan(opts).map((e) => [e.file, e]));
    expect(files["prisma/migrations/20270101000000_gen_warehouse_item/migration.sql"].create).toMatch(/ENABLE ROW LEVEL SECURITY[\s\S]*tenant_isolation/);
    expect(files["apps/api/src/modules/warehouse-item.controller.ts"].create).toContain("PERMS.warehouseItemRemove");
    const registry = JSON.stringify(files["apps/api/test/leak/registry.ts"].patches);
    expect(registry).toContain("/api/warehouse-items/:id");
    expect(registry).toContain("POST /api/warehouse-items");
  });
});
