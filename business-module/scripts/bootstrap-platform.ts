// 创建第一个平台账号（内置、平台超级管理员），并发"设置密码"邀请邮件（Mailpit 里看）。
//   pnpm bootstrap:platform --username root --email root@platform.example.test
// 前提：平台域已创建（pnpm realm）。可重复运行。本机想直接用密码登录：再运行
//   pnpm dev:password --platform --username root --password '...'
import { parseArgs } from "node:util";
import { PrismaClient } from "../apps/api/src/generated/prisma";
import { KeycloakAdmin } from "../apps/api/src/keycloak/keycloak-admin";
import { bootstrapPlatformAccount } from "../apps/api/src/platform/bootstrap";
import { loadLocalEnv } from "./lib/keycloak";

async function main(): Promise<void> {
  loadLocalEnv();
  const { values } = parseArgs({ options: { username: { type: "string", default: "root" }, email: { type: "string", default: "root@platform.example.test" } } });
  const owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
  try {
    const result = await bootstrapPlatformAccount(owner, await KeycloakAdmin.connect(), { username: values.username as string, email: values.email as string });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await owner.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
