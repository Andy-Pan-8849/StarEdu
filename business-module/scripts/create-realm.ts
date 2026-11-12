// 用域模板在 Keycloak 里创建租户域或平台域。
//   pnpm realm --kind tenant --code hq --name "StarIT"
//   pnpm realm --kind platform
// 已存在时默认跳过；加 --recreate 会删除后重建（本地开发用，会丢掉该域的所有用户）。
import { parseArgs } from "node:util";
import { adjustUserProfile, buildRealm, realmName, type RealmKind } from "../packages/shared/src/realm";
import { checkTenantCode } from "../packages/shared/src/tenant-code";
import { KeycloakAdmin, loadLocalEnv } from "./lib/keycloak";

export async function createRealm(
  admin: KeycloakAdmin,
  opts: { kind: RealmKind; code: string; name: string; recreate?: boolean; allowDirectGrant?: boolean },
): Promise<string> {
  const { kind, code } = opts;
  if (kind === "tenant") {
    const problem = checkTenantCode(code);
    if (problem) throw new Error(`invalid tenant code "${code}": ${problem}`);
  }
  const name = realmName(kind, code);
  if (await admin.realmExists(name)) {
    if (!opts.recreate) return `${name}: already exists, skipped`;
    await admin.deleteRealm(name);
  }
  const webPort = process.env.WEB_PORT ?? "3001";
  const host = kind === "platform" ? "platform.localhost" : `${code}.localhost`;
  await admin.createRealm(
    buildRealm({
      kind,
      code,
      displayName: opts.name,
      tenantId: code, // B1 起换成租户表的 id
      webOrigin: `http://${host}:${webPort}`,
      smtp: {
        // Keycloak 在容器里，通过 Compose 网络访问 Mailpit；改成真实 SMTP 只改环境变量
        host: process.env.KEYCLOAK_SMTP_HOST ?? "mailpit",
        port: Number(process.env.KEYCLOAK_SMTP_PORT ?? 1025),
        from: process.env.SMTP_FROM ?? "no-reply@staredu.test",
        fromDisplayName: "StarEdu",
      },
      allowDirectGrant: opts.allowDirectGrant,
    }),
  );
  await admin.setUserProfile(name, adjustUserProfile(await admin.getUserProfile(name)));
  return `${name}: created`;
}

async function main(): Promise<void> {
  loadLocalEnv();
  const { values } = parseArgs({
    options: {
      kind: { type: "string", default: "tenant" },
      code: { type: "string" },
      name: { type: "string" },
      recreate: { type: "boolean", default: false },
    },
  });
  const kind = values.kind as RealmKind;
  if (kind !== "tenant" && kind !== "platform") throw new Error("--kind must be tenant or platform");
  const code = kind === "platform" ? "platform" : values.code;
  if (!code) throw new Error("--code is required for a tenant realm");
  const admin = await KeycloakAdmin.connect();
  console.log(
    await createRealm(admin, {
      kind,
      code,
      name: values.name ?? (kind === "platform" ? "StarEdu Platform" : code),
      recreate: values.recreate,
    }),
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
