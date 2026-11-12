// 用域模板在 Keycloak 里创建平台域（租户域由 provision-tenant 创建，因为它要先有租户记录）。
//   pnpm realm --kind platform
// 已存在时默认跳过；加 --recreate 会删除后重建（本地开发用，会丢掉该域的所有用户）。
import { parseArgs } from "node:util";
import { KeycloakAdmin } from "../apps/api/src/keycloak/keycloak-admin";
import { createRealm, smtpFromEnv, tenantOrigin } from "../apps/api/src/keycloak/realm-provisioner";
import { loadLocalEnv } from "./lib/keycloak";

async function main(): Promise<void> {
  loadLocalEnv();
  const { values } = parseArgs({ options: { recreate: { type: "boolean", default: false } } });
  const admin = await KeycloakAdmin.connect();
  const result = await createRealm(admin, {
    kind: "platform",
    code: "platform",
    name: "StarEdu Platform",
    tenantId: "platform",
    webOrigin: tenantOrigin("platform"),
    smtp: smtpFromEnv(),
    recreate: values.recreate,
  });
  console.log(`platform: ${result === "created" ? "created" : "already exists, skipped"}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
