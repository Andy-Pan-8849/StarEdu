// 用法：pnpm gen:module --name warehouse-item --group edu --fields "title:string!,qty:int,due:date,done:bool,notes:text" --label "Warehouse items" --label-zh "仓库物品" [--plural warehouse-items] [--dry-run]
// 字段类型：string text int bool date；类型后加 ! 表示必填。生成后：pnpm migrate && pnpm prisma:generate，再跑测试。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { applyPatches, buildPlan, namesOf, parseFields } from "../packages/shared/src/gen-module";

const root = resolve(__dirname, "..");
const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) throw new Error(`Unexpected argument ${argv[i]}`);
  const key = argv[i].slice(2);
  if (key === "dry-run") args.set(key, "1");
  else args.set(key, argv[++i] ?? "");
}
const need = (k: string) => {
  const v = args.get(k);
  if (!v) throw new Error(`Missing --${k}`);
  return v;
};

const name = need("name");
const group = need("group");
const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const opts = { name, group, plural: args.get("plural"), fields: parseFields(need("fields")), label: need("label"), labelZh: args.get("label-zh") ?? need("label"), stamp };
const n = namesOf(opts);

const catalog = readFileSync(join(root, "packages/shared/src/menu-catalog.ts"), "utf8");
if (!new RegExp(`code: "${group}", type: "directory"`).test(catalog)) throw new Error(`Menu directory "${group}" does not exist`);
if (catalog.includes(`"${n.menuCode}"`)) throw new Error(`Menu ${n.menuCode} already exists`);
if (readFileSync(join(root, "prisma/schema.prisma"), "utf8").includes(`model ${n.pascal} {`)) throw new Error(`Model ${n.pascal} already exists`);

// 先全部算好，再一起写
const out: Array<{ file: string; text: string }> = [];
for (const e of buildPlan(opts)) {
  const path = join(root, e.file);
  if (e.create !== undefined) {
    if (existsSync(path)) throw new Error(`${e.file} already exists`);
    out.push({ file: e.file, text: e.create });
  } else {
    out.push({ file: e.file, text: applyPatches(readFileSync(path, "utf8"), e.patches ?? [], e.file) });
  }
}
if (args.has("dry-run")) {
  console.log(out.map((o) => o.file).join("\n"));
  process.exit(0);
}
for (const o of out) {
  mkdirSync(dirname(join(root, o.file)), { recursive: true });
  writeFileSync(join(root, o.file), o.text);
}
console.log(`${out.length} files written for ${n.pascal}:\n${out.map((o) => `  ${o.file}`).join("\n")}\n\nNext: pnpm migrate && pnpm prisma:generate && pnpm --filter @staredu/shared build, then run the new test (apps/api/test/modules/${n.kebab}.e2e.spec.ts) and test/leak.\nThe built-in administrator sees the new menu at once; give it to other roles in Roles, or add its code (${n.menuCode} and its buttons) to a role template in packages/shared/src/role-templates.ts.`);
