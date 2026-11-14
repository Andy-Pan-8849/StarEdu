// 演示数据：教学（班级、作业、提交、总评）、演示账号（Keycloak 用户，统一演示密码）、文档库。可重复运行。
// 先决条件：pnpm seed（开通 hq 租户）和 pnpm import:sample（校区、员工、学员）。一条命令：pnpm demo。
//   pnpm seed:demo [--code hq] [--no-accounts] [--no-library]
// 演示密码默认 Demo!Passw0rd2026（公开的演示值，只用于本地演示），可用环境变量 DEMO_PASSWORD 改。
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { PrismaClient } from "../apps/api/src/generated/prisma";
import { KeycloakAdmin } from "../apps/api/src/keycloak/keycloak-admin";
import { ObjectStoreService } from "../apps/api/src/storage/object-store.service";
import { seedDemo } from "../apps/api/src/demo/demo-data";
import { loadLocalEnv } from "./lib/keycloak";

async function main(): Promise<void> {
  loadLocalEnv();
  const { values } = parseArgs({ options: { code: { type: "string", default: "hq" }, "no-accounts": { type: "boolean" }, "no-library": { type: "boolean" } } });
  const owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
  try {
    const store = new ObjectStoreService();
    const result = await seedDemo({
      owner,
      tenantCode: values.code as string,
      sampleDir: resolve(__dirname, "../../ai-module/sample-data"),
      keycloak: values["no-accounts"] ? undefined : await KeycloakAdmin.connect(),
      putObject: values["no-library"] ? undefined : (key, body, type) => store.put(key, body, type),
      emitLibraryEvents: process.env.BIZ_EVENT_BUS === "kafka",
      log: console.log,
    });
    console.log(JSON.stringify(result));
  } finally {
    await owner.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
