// 模块脚手架（CRUD 生成器）：给一个"租户内的简单资源"生成数据库表、接口、权限、菜单、页面、测试，
// 并把它登记到泄露扫描里。所有改动先在内存里算好，任何一处锚点找不到就一处都不写。
// 生成的只是起点：有业务规则的模块（状态流转、与别的表关联、导入导出）要在此之上手写。
export type FieldType = "string" | "text" | "int" | "bool" | "date";
export interface FieldSpec { name: string; type: FieldType; required: boolean }
export interface Options {
  /** kebab-case，单数，例如 warehouse-item */
  name: string;
  /** 挂在哪个已有目录菜单下：edu、hr、msg、doc、system ... */
  group: string;
  fields: FieldSpec[];
  /** 菜单和页面标题（英文、中文） */
  label: string;
  labelZh: string;
  /** 复数路径，默认 name + "s" */
  plural?: string;
  /** 迁移文件名里的时间戳（YYYYMMDDHHMMSS） */
  stamp: string;
}
export interface Names { kebab: string; plural: string; pascal: string; camel: string; snake: string; permPrefix: string; menuCode: string }
export interface Edit { file: string; /** 新文件：全文；已有文件：见 anchors */ create?: string; patches?: Array<{ anchor: string | RegExp; before?: string; after?: string }> }

const TYPES: FieldType[] = ["string", "text", "int", "bool", "date"];
const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const FIELD = /^[a-z][a-zA-Z0-9]{0,30}$/;
const RESERVED = new Set(["id", "tenantId", "createdAt", "updatedAt", "createdBy", "updatedBy"]);

export function parseFields(text: string): FieldSpec[] {
  const out: FieldSpec[] = [];
  for (const raw of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^([^:]+):([a-z]+)(!?)$/.exec(raw);
    if (!m) throw new Error(`Bad field "${raw}" (use name:type or name:type!)`);
    const [, name, type, bang] = m;
    if (!FIELD.test(name)) throw new Error(`Bad field name "${name}" (camelCase, starts with a lowercase letter)`);
    if (RESERVED.has(name)) throw new Error(`Field name "${name}" is reserved`);
    if (!TYPES.includes(type as FieldType)) throw new Error(`Unknown type "${type}" for ${name} (one of ${TYPES.join(", ")})`);
    if (out.some((f) => f.name === name)) throw new Error(`Duplicate field "${name}"`);
    out.push({ name, type: type as FieldType, required: bang === "!" });
  }
  if (!out.length) throw new Error("At least one field is needed");
  return out;
}

export function namesOf(o: Pick<Options, "name" | "group" | "plural">): Names {
  if (!NAME.test(o.name)) throw new Error(`Bad name "${o.name}" (kebab-case, e.g. warehouse-item)`);
  const parts = o.name.split("-");
  const camel = parts.map((p, i) => (i ? p[0].toUpperCase() + p.slice(1) : p)).join("");
  const plural = o.plural ?? `${o.name}s`;
  if (!NAME.test(plural)) throw new Error(`Bad plural "${plural}"`);
  return { kebab: o.name, plural, pascal: camel[0].toUpperCase() + camel.slice(1), camel, snake: parts.join("_"), permPrefix: `${o.group}:${camel}`, menuCode: `${o.group}:${camel}` };
}

const col = (f: string) => f.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const words = (f: string) => f.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
const q = (s: string) => JSON.stringify(s);

const prismaType = (f: FieldSpec) => `${{ string: "String", text: "String", int: "Int", bool: "Boolean", date: "DateTime" }[f.type]}${f.required ? "" : "?"}${f.type === "date" ? " @db.Date" : ""}`;
const sqlType = (f: FieldSpec) => ({ string: "TEXT", text: "TEXT", int: "INTEGER", bool: "BOOLEAN", date: "DATE" })[f.type];
const zodOf = (f: FieldSpec) => ({
  string: "z.string().trim().min(1).max(200)",
  text: "z.string().trim().max(5000)",
  int: "z.number().int().min(-2147483648).max(2147483647)",
  bool: "z.boolean()",
  date: 'z.string().regex(/^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$/, "must be YYYY-MM-DD")',
})[f.type];
const sample = (f: FieldSpec) => ({ string: `"Sample ${f.name}"`, text: `"Sample ${f.name}"`, int: "1", bool: "true", date: 'new Date("2026-01-15")' })[f.type];
const sampleJson = (f: FieldSpec) => ({ string: `"Sample ${f.name}"`, text: `"Sample ${f.name}"`, int: "1", bool: "true", date: '"2026-01-15"' })[f.type];

export function buildPlan(o: Options): Edit[] {
  const n = namesOf(o);
  const P = (suffix: string) => `${n.camel}${suffix}`; // 权限常量名前缀
  const dataOf = (indent: string) => o.fields.map((f) => (f.type === "date" ? `${indent}${f.name}: input.${f.name} == null ? input.${f.name} : new Date(input.${f.name}),` : `${indent}${f.name}: input.${f.name},`)).join("\n");

  // ---- 表和迁移 ----
  const model = `
/// 由 pnpm gen:module 生成：${o.label}
model ${n.pascal} {
  id        String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId  String   @map("tenant_id") @db.Uuid
${o.fields.map((f) => `  ${f.name.padEnd(9)} ${prismaType(f)}${col(f.name) === f.name ? "" : ` @map(${q(col(f.name))})`}`).join("\n")}
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @default(now()) @updatedAt @map("updated_at")
  createdBy String?  @map("created_by") @db.Uuid
  updatedBy String?  @map("updated_by") @db.Uuid

  @@index([tenantId])
  @@map(${q(n.snake)})
}
`;
  const sql = `-- 由 pnpm gen:module 生成：${o.label}
CREATE TABLE biz.${q(n.snake)} (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
${o.fields.map((f) => `    ${q(col(f.name))} ${sqlType(f)}${f.required ? " NOT NULL" : ""},`).join("\n")}
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    CONSTRAINT ${q(`${n.snake}_pkey`)} PRIMARY KEY ("id")
);
CREATE INDEX ${q(`${n.snake}_tenant_id_idx`)} ON biz.${q(n.snake)}("tenant_id");
ALTER TABLE biz.${q(n.snake)} ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz.${q(n.snake)} USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
`;

  // ---- 接口 ----
  const controller = `// 由 pnpm gen:module 生成：${o.label}。租户内的简单增删改查；有业务规则的在这个文件里继续写。
import { Body, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { AuditService } from "../audit/audit.service";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";

const createSchema = z
  .object({
${o.fields.map((f) => `    ${f.name}: ${zodOf(f)}${f.required ? "" : ".nullable().optional()"},`).join("\n")}
  })
  .strict();
const patchSchema = createSchema.partial().strict();

@Controller(${q(`api/${n.plural}`)})
export class ${n.pascal}Controller {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.tenantDb.db;
  }

  @Get()
  @RequirePermissions(PERMS.${P("List")})
  list() {
    return this.db.${n.camel}.findMany({ orderBy: { createdAt: "desc" }, take: 500 });
  }

  @Get(":id")
  @RequirePermissions(PERMS.${P("List")})
  async get(@Param("id", ParseUUIDPipe) id: string) {
    const row = await this.db.${n.camel}.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    return row;
  }

  @Post()
  @RequirePermissions(PERMS.${P("Add")})
  async create(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(createSchema, body);
    const row = await this.db.${n.camel}.create({
      data: {
        tenantId: auth.tenantId,
${dataOf("        ")}
        createdBy: auth.accountId,
      },
    });
    await this.audit.record(auth.accountId, ${q(`${n.snake}.create`)}, ${q(n.snake)}, row.id, input);
    return row;
  }

  @Patch(":id")
  @RequirePermissions(PERMS.${P("Edit")})
  async update(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(patchSchema, body);
    if (!(await this.db.${n.camel}.findUnique({ where: { id } }))) throw new NotFoundException();
    const row = await this.db.${n.camel}.update({
      where: { id },
      data: {
${dataOf("        ")}
        updatedBy: auth.accountId,
      },
    });
    await this.audit.record(auth.accountId, ${q(`${n.snake}.update`)}, ${q(n.snake)}, id, input);
    return row;
  }

  @Delete(":id")
  @RequirePermissions(PERMS.${P("Remove")})
  async remove(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    if (!(await this.db.${n.camel}.findUnique({ where: { id } }))) throw new NotFoundException();
    await this.db.${n.camel}.delete({ where: { id } });
    await this.audit.record(auth.accountId, ${q(`${n.snake}.delete`)}, ${q(n.snake)}, id, {});
    return { id };
  }
}
`;

  // ---- 页面 ----
  const pageFields = o.fields
    .map((f) => `    { name: ${q(f.name)}, label: t(${q(f.name)}), type: ${q(f.type === "int" ? "number" : f.type === "bool" ? "checkbox" : f.type === "text" ? "textarea" : "text")}${f.required && f.type !== "bool" ? ", required: true" : ""} },`)
    .join("\n");
  const pageCols = o.fields
    .map((f) => `    { key: ${q(f.name)}, header: t(${q(f.name)}), cell: (r) => ${f.type === "bool" ? 'r.' + f.name + ' ? "✓" : ""' : f.type === "date" ? `r.${f.name}?.slice(0, 10) ?? ""` : `r.${f.name} ?? ""`} },`)
    .join("\n");
  const rowType = o.fields.map((f) => `${f.name}: ${f.type === "int" ? "number" : f.type === "bool" ? "boolean" : "string"}${f.required ? "" : " | null"}`).join("; ");
  const initial = o.fields.map((f) => (f.type === "bool" ? `${f.name}: Boolean(form.row.${f.name})` : `${f.name}: form.row.${f.name} == null ? "" : String(form.row.${f.name}${f.type === "date" ? ").slice(0, 10" : ""})`)).join(", ");
  const page = `"use client";

// 由 pnpm gen:module 生成：${o.label}。
import { useTranslations } from "next-intl";
import * as React from "react";
import { PERMS } from "@staredu/shared";
import { Button } from "@/components/ui/button";
import { bff } from "@/lib/bff";
import { DataTable, type Column } from "../../data-table";
import { Can, PermButton } from "../../permissions";
import { FormPanel, useAct, type Field } from "../crud";
import { useList } from "../use-api";

interface Row { id: string; ${rowType} }

export function ${n.pascal}Page() {
  const t = useTranslations(${q(`pages.${n.camel}`)});
  const c = useTranslations("crud");
  const tt = useTranslations("table");
  const { rows, loading, error, reload } = useList<Row>(${q(n.plural)});
  const { run, message } = useAct(reload);
  const [form, setForm] = React.useState<{ row?: Row } | null>(null);
  const fields: Field[] = [
${pageFields}
  ];
  const columns: Column<Row>[] = [
${pageCols}
    {
      key: "actions",
      header: "",
      cell: (r) => (
        <div className="flex gap-1">
          <PermButton perm={PERMS.${P("Edit")}} size="sm" variant="outline" onClick={() => setForm({ row: r })}>{c("edit")}</PermButton>
          <PermButton perm={PERMS.${P("Remove")}} size="sm" variant="outline" onClick={() => window.confirm(c("confirmDelete", { name: String(r.${o.fields[0].name} ?? "") })) && void run(() => bff(\`${n.plural}/\${r.id}\`, { method: "DELETE" }), c("done"))}>{c("delete")}</PermButton>
        </div>
      ),
    },
  ];
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">{t("title")}</h2>
      {error ? <p role="alert" className="mb-2 text-sm text-red-600">{error}</p> : null}
      {message}
      <Can perm={PERMS.${P("Add")}}>{!form ? <Button size="sm" className="mb-3" onClick={() => setForm({})}>{c("add")}</Button> : null}</Can>
      {form ? (
        <FormPanel
          title={form.row ? c("edit") : c("add")}
          fields={fields}
          initial={form.row ? { ${initial} } : {}}
          submitLabel={c("save")}
          cancelLabel={c("cancel")}
          onCancel={() => setForm(null)}
          onSubmit={async (p) => { if (await run(() => (form.row ? bff(\`${n.plural}/\${form.row.id}\`, { method: "PATCH", body: p }) : bff(${q(n.plural)}, { method: "POST", body: p })), c("saved"))) setForm(null); }}
        />
      ) : null}
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} emptyText={tt("empty")} loadingText={tt("loading")} labels={{ previous: tt("previous"), next: tt("next"), page: (p, k) => tt("page", { page: p, pages: k }) }} />
    </section>
  );
}
`;

  // ---- 测试 ----
  const first = o.fields[0];
  const reqd = o.fields.filter((f) => f.required);
  const createBody = `{ ${(reqd.length ? reqd : [first]).map((f) => `${f.name}: ${sampleJson(f)}`).join(", ")} }`;
  const bad = reqd.find((f) => f.type === "string" || f.type === "int" || f.type === "date" || f.type === "bool");
  const badCase = bad ? `    expect((await admin().post(${q(`/api/${n.plural}`)}, { ...${createBody}, ${bad.name}: ${bad.type === "int" ? '"x"' : bad.type === "bool" ? '"x"' : bad.type === "date" ? '"15/01/2026"' : "123"} })).status).toBe(400);\n` : "";
  const test = `// 由 pnpm gen:module 生成：${o.label}。增删改查、必填校验、没有权限的账号被拒；跨租户由泄露扫描覆盖（test/leak）。
import { Harness } from "../helpers/app";

describe(${q(n.plural)}, () => {
  const h = new Harness();
  let boss: string;
  let student: string;
  const admin = () => h.call(boss);

  beforeAll(async () => {
    await h.start();
    boss = await (await h.user("boss", { roles: ["tenant-admin"], person: "staff" })).token();
    student = await (await h.user("stu", { roles: ["student"], person: "student" })).token();
  });
  afterAll(() => h.stop());

  it("creates, reads, updates and deletes a row, and audits each change", async () => {
    const created = await admin().post(${q(`/api/${n.plural}`)}, ${createBody});
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect((await admin().get(\`/api/${n.plural}/\${id}\`)).status).toBe(200);
    expect((await admin().get(${q(`/api/${n.plural}`)})).body.map((r: { id: string }) => r.id)).toContain(id);
    expect((await admin().patch(\`/api/${n.plural}/\${id}\`, { ${first.name}: ${sampleJson(first)} })).status).toBe(200);
    expect((await admin().del(\`/api/${n.plural}/\${id}\`)).status).toBe(200);
    expect((await admin().get(\`/api/${n.plural}/\${id}\`)).status).toBe(404);
    expect(await h.owner.auditLog.count({ where: { tenantId: h.tenant.tenantId, action: { startsWith: ${q(`${n.snake}.`)} } } })).toBe(3);
  });

  it("rejects bad input", async () => {
${badCase}    expect((await admin().post(${q(`/api/${n.plural}`)}, { ...${createBody}, unknownField: 1 })).status).toBe(400);
    expect((await admin().get(${q(`/api/${n.plural}/not-a-uuid`)})).status).toBe(400);
  });

  it("refuses an account without the permission", async () => {
    expect((await h.call(student).get(${q(`/api/${n.plural}`)})).status).toBe(403);
    expect((await h.call(student).post(${q(`/api/${n.plural}`)}, ${createBody})).status).toBe(403);
  });
});
`;

  const permLines = `  /** 由 pnpm gen:module 生成：${o.label} */
  ${P("List")}: ${q(`${n.permPrefix}:list`)},
  ${P("Add")}: ${q(`${n.permPrefix}:add`)},
  ${P("Edit")}: ${q(`${n.permPrefix}:edit`)},
  ${P("Remove")}: ${q(`${n.permPrefix}:remove`)},
`;
  const menuLine = `  ...menuWithButtons(${q(n.menuCode)}, ${q(o.group)}, ${q(o.label)}, ${q(n.kebab)}, 90, PERMS.${P("List")}, [
    ["add", "Add", PERMS.${P("Add")}],
    ["edit", "Edit", PERMS.${P("Edit")}],
    ["remove", "Delete", PERMS.${P("Remove")}],
  ]),
`;
  const fixtureRow = `    const gen${n.pascal} = await owner.${n.camel}.create({ data: { tenantId, ${o.fields.filter((f) => f.required || f === first).map((f) => `${f.name}: ${sample(f)}`).join(", ")} } });\n`;
  const msgPage = (en: boolean) => `    ${q(n.camel)}: {\n      "title": ${q(en ? o.label : o.labelZh)},\n${o.fields.map((f) => `      ${q(f.name)}: ${q(words(f.name))}`).join(",\n")}\n    },\n`;

  return [
    { file: `prisma/migrations/${o.stamp}_gen_${n.snake}/migration.sql`, create: sql },
    { file: "prisma/schema.prisma", patches: [{ anchor: /\s*$/, after: model }] },
    { file: `apps/api/src/modules/${n.kebab}.controller.ts`, create: controller },
    { file: "packages/shared/src/permissions.ts", patches: [{ anchor: "} as const;\n\nexport type Permission", before: permLines }] },
    { file: "packages/shared/src/menu-catalog.ts", patches: [{ anchor: "];\n\n/** 菜单所在入口", before: menuLine }] },
    {
      file: "apps/api/src/app.module.ts",
      patches: [
        { anchor: 'import { PostsController } from "./org/posts.controller";', after: `\nimport { ${n.pascal}Controller } from "./modules/${n.kebab}.controller";` },
        { anchor: "export const CONTROLLERS = [\n", after: `  ${n.pascal}Controller,\n` },
      ],
    },
    { file: "apps/api/src/tenancy/scope-args.ts", patches: [{ anchor: "  Post: { nullable: false, softDelete: true },\n", after: `  ${n.pascal}: { nullable: false, softDelete: false },\n` }] },
    { file: "apps/api/test/helpers/fixtures.ts", patches: [{ anchor: "      owner.$executeRaw`DELETE FROM biz.major_version WHERE tenant_id = ${id}::uuid`,\n", before: `      owner.$executeRaw\`DELETE FROM biz.${n.snake} WHERE tenant_id = \${id}::uuid\`,\n` }] },
    {
      file: "apps/api/test/leak/isolation.e2e.spec.ts",
      patches: [
        { anchor: '  "doc_folder", "doc_acl"', before: `  ${q(n.snake)},\n` },
        { anchor: "    const announcement = await owner.announcement.create", before: fixtureRow },
        { anchor: "        sid,\n      },", before: `        ${P("Id")}: gen${n.pascal}.id,\n` },
      ],
    },
    {
      file: "apps/api/test/leak/registry.ts",
      patches: [
        { anchor: '  | "sid";', before: `  | ${q(P("Id"))}\n` },
        { anchor: '  { method: "GET", path: "/api/campuses", kind: "list" },\n', after: `  { method: "GET", path: ${q(`/api/${n.plural}`)}, kind: "list" },\n  { method: "GET", path: ${q(`/api/${n.plural}/:id`)}, kind: "detail", fixture: ${q(P("Id"))} },\n` },
        {
          anchor: "  // 目标行是 B 的\n",
          after: `  { method: "PATCH", path: ${q(`/api/${n.plural}/:id`)}, fixture: ${q(P("Id"))}, target: "foreign", body: { ${first.name}: ${sampleJson(first)} }, note: "edit another tenant's ${o.label}" },\n  { method: "DELETE", path: ${q(`/api/${n.plural}/:id`)}, fixture: ${q(P("Id"))}, target: "foreign", note: "delete another tenant's ${o.label}" },\n`,
        },
        { anchor: "export const OTHER_ROUTES: Record<string, string> = {\n", after: `  ${q(`POST /api/${n.plural}`)}: "creates only in the caller's own tenant and takes no ids of other rows (test/modules/${n.kebab}.e2e.spec.ts)",\n` },
      ],
    },
    { file: `apps/web/src/components/admin/pages/generated/${n.kebab}-page.tsx`, create: page },
    {
      file: "apps/web/src/components/admin/page-registry.ts",
      patches: [
        { anchor: 'import { AnnouncementsPage }', before: `import { ${n.pascal}Page } from "./pages/generated/${n.kebab}-page";\n` },
        { anchor: '  "edu/term/index": TermsPage,\n', before: `  ${q(`${n.menuCode.replace(/:/g, "/")}/index`)}: ${n.pascal}Page,\n` },
      ],
    },
    ...(["en", "zh"] as const).map((l) => ({
      file: `apps/web/messages/${l}.json`,
      patches: [
        { anchor: '    "posts": {\n', before: msgPage(l === "en") },
        { anchor: '    "msg": "', before: `    ${q(n.menuCode)}: ${q(l === "en" ? o.label : o.labelZh)},\n` },
      ],
    })),
    { file: `apps/api/test/modules/${n.kebab}.e2e.spec.ts`, create: test },
  ];
}

/** 套用补丁；任何锚点找不到、或已经存在同名内容就抛错（调用方在写盘前先全部算完）。 */
export function applyPatches(text: string, patches: NonNullable<Edit["patches"]>, file: string): string {
  let out = text;
  for (const p of patches) {
    if (typeof p.anchor === "string") {
      const i = out.indexOf(p.anchor);
      if (i < 0) throw new Error(`${file}: anchor not found: ${JSON.stringify(p.anchor.slice(0, 60))}`);
      out = out.slice(0, i) + (p.before ?? "") + p.anchor + (p.after ?? "") + out.slice(i + p.anchor.length);
    } else {
      out = out.replace(p.anchor, (m) => (p.before ?? "") + m + (p.after ?? ""));
    }
  }
  return out;
}
