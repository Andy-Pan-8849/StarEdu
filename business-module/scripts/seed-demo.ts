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
import { DEMO_PASSWORD, seedScenario } from "../apps/api/src/demo/demo-scenario";
import { bootstrapPlatformAccount } from "../apps/api/src/platform/bootstrap";
import { loadLocalEnv } from "./lib/keycloak";

/** 演示公司。hq 有 AI 样本数据（再加演示场景）；加盟公司只有一份小而完整的演示场景。prefix 是演示账号的前缀。 */
const DEMO_TENANTS = [
  { code: "hq", prefix: "demo" },
  { code: "riverside-franchise", prefix: "rv" },
];

async function main(): Promise<void> {
  loadLocalEnv();
  const { values } = parseArgs({ options: { code: { type: "string", default: "hq" }, "no-accounts": { type: "boolean" }, "no-library": { type: "boolean" } } });
  const owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
  try {
    // 演示公司：打上"演示"标记（只有带标记的公司才允许演示账号、演示角色和一键重置）
    await owner.tenant.updateMany({ where: { code: { in: DEMO_TENANTS.map((t) => t.code) } }, data: { isDemo: true } });
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
    const keycloak = values["no-accounts"] ? undefined : await KeycloakAdmin.connect();
    for (const t of DEMO_TENANTS) {
      if (!(await owner.tenant.findUnique({ where: { code: t.code } }))) {
        console.log(`scenario: tenant ${t.code} not found, skipped (run pnpm seed first)`);
        continue;
      }
      console.log(JSON.stringify(await seedScenario({ owner, tenantCode: t.code, prefix: t.prefix, keycloak, log: console.log })));
      // 演示公司的登录页显示演示账号（Keycloak 登录主题 staredu-demo）；生产公司不设这个主题，完全不受影响
      if (keycloak) await keycloak.updateRealm(`tenant-${t.code}`, { loginTheme: "staredu-demo" });
    }
    if (keycloak) {
      await bootstrapPlatformAccount(owner, keycloak, { username: "demo.operator", email: "demo.operator@platform.example.test", password: process.env.DEMO_PASSWORD ?? DEMO_PASSWORD, sendInvite: false });
      await keycloak.updateRealm("platform", { loginTheme: "staredu-demo" });
      console.log("platform: demo.operator ready");
    }
  } finally {
    await owner.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
