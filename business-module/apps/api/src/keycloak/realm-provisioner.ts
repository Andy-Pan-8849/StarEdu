// 用域模板在 Keycloak 里创建租户域或平台域（和"新增租户"共用）。
import {
  adjustUserProfile,
  buildRealm,
  checkTenantCode,
  realmName,
  type RealmKind,
} from "@staredu/shared";
import type { KeycloakAdmin } from "./keycloak-admin";

export interface RealmOptions {
  kind: RealmKind;
  code: string;
  name: string;
  /** 写进令牌 tenant_id 声明的值（租户表的 id；平台域用 "platform"）。 */
  tenantId: string;
  /** 前端来源，如 http://hq.localhost:3001 */
  webOrigin: string;
  smtp: { host: string; port: number; from: string };
  recreate?: boolean;
  /** 仅测试：打开密码直连授权，让脚本不用浏览器就能换令牌。 */
  allowDirectGrant?: boolean;
}

export async function createRealm(admin: KeycloakAdmin, opts: RealmOptions): Promise<"created" | "exists"> {
  if (opts.kind === "tenant") {
    const problem = checkTenantCode(opts.code);
    if (problem) throw new Error(`invalid tenant code "${opts.code}": ${problem}`);
  }
  const name = realmName(opts.kind, opts.code);
  if (await admin.realmExists(name)) {
    if (!opts.recreate) return "exists";
    await admin.deleteRealm(name);
  }
  await admin.createRealm(
    buildRealm({
      kind: opts.kind,
      code: opts.code,
      displayName: opts.name,
      tenantId: opts.tenantId,
      webOrigin: opts.webOrigin,
      smtp: { ...opts.smtp, fromDisplayName: "StarEdu" },
      allowDirectGrant: opts.allowDirectGrant,
    }),
  );
  await admin.setUserProfile(name, adjustUserProfile(await admin.getUserProfile(name)));
  return "created";
}

/** 租户网址模板，如 "http://{code}.localhost:3001"。 */
export function tenantOrigin(code: string, env: NodeJS.ProcessEnv = process.env): string {
  const template = env.TENANT_ORIGIN_TEMPLATE ?? `http://{code}.localhost:${env.WEB_PORT ?? "3001"}`;
  return template.replace("{code}", code);
}

export function smtpFromEnv(env: NodeJS.ProcessEnv = process.env): RealmOptions["smtp"] {
  return {
    // Keycloak 在容器里，经 Compose 网络访问 Mailpit；改成真实 SMTP 只改环境变量
    host: env.KEYCLOAK_SMTP_HOST ?? "mailpit",
    port: Number(env.KEYCLOAK_SMTP_PORT ?? 1025),
    from: env.SMTP_FROM ?? "no-reply@staredu.test",
  };
}
