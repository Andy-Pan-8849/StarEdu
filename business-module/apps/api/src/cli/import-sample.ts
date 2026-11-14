// 把 AI 模块的样例数据（8 个校区、141 名员工、60 名学生）导入某个租户（默认 hq）。可重复运行。
//   pnpm import:sample -- [--code hq] [--dir <样例目录>]
// 样例里的总部校区编号是 BJ，业务模块里总部校区的代码是 HQ，所以导入时做 BJ → HQ 的映射。
// 通过应用自己的导入服务写入（和界面上的"导入 CSV"同一套规则），不绕过任何校验。
import "reflect-metadata";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { NestFactory } from "@nestjs/core";
import type { INestApplicationContext } from "@nestjs/common";
import { AppModule } from "../app.module";
import { ImportService } from "../hr/import.service";
import { PrismaService } from "../prisma/prisma.service";
import { runInScope } from "../tenancy/request-scope";
import type { AuthContext } from "../auth/tenant-token.guard";

/** 导入校区、员工、学员（可重复运行）；测试里也用它。 */
export async function importSample(app: INestApplicationContext, code: string, dir: string, log: (line: string) => void = console.log): Promise<void> {
  const rows = await app.get(PrismaService).$queryRaw<Array<{ id: string; code: string; name: string; status: string }>>`SELECT * FROM biz.resolve_tenant(${code})`;
  const tenant = rows[0];
  if (!tenant) throw new Error(`tenant "${code}" not found (run pnpm seed first)`);
  const imports = app.get(ImportService);
  const auth = { system: true, accountId: null, tenantId: tenant.id } as unknown as AuthContext;
  const read = (f: string) => readFileSync(resolve(dir, f), "utf8");
  const opts = { campusAliases: { BJ: "HQ" } };
  await runInScope({ kind: "tenant", tenantId: tenant.id, code: tenant.code, name: tenant.name, status: tenant.status }, async () => {
    for (const [label, run] of [
      ["campuses", () => imports.importCampuses(auth, "system:campus:add", read("campuses.csv"), opts)],
      ["staff", () => imports.importStaff(auth, read("employees.csv"), opts)],
      ["students", () => imports.importStudents(auth, read("students.csv"), opts)],
    ] as const) {
      const r = await run();
      log(`${label}: ${r.created} created, ${r.updated} updated, ${r.unchanged} unchanged, ${r.errors.length} errors`);
      for (const e of r.errors.slice(0, 5)) log(`  row ${e.row}: ${e.message}`);
    }
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { code: { type: "string", default: "hq" }, dir: { type: "string", default: resolve(__dirname, "../../../../../ai-module/sample-data/structured") } } });
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
  try {
    await importSample(app, values.code as string, values.dir as string);
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
