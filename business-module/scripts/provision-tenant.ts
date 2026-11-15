// 开通一个租户（可重复运行：失败后再运行同一条命令会从断点继续）。
//   pnpm provision --code hq --name "StarIT" --admin-email admin@hq.example.test
//   pnpm provision --code franchise --name "StarIT Franchise" --type franchise --admin-email ...
import { createRequire } from "node:module";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { PrismaClient, TenantType } from "../apps/api/src/generated/prisma";
import { KeycloakAdmin } from "../apps/api/src/keycloak/keycloak-admin";
import { ProvisioningService } from "../apps/api/src/provisioning/provisioning.service";
import { loadLocalEnv } from "./lib/keycloak";

/** 菜单目录、角色或功能授权可能变了：让该租户所有人的权限缓存立即作废（和接口里的 bump 同一个键）。Redis 连不上只提示，缓存最多一小时后自然过期。 */
async function invalidatePermissionCache(tenantId: string): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) return;
  // ioredis 装在接口项目里，脚本目录解析不到，所以从接口项目的位置加载
  type RedisLike = { connect(): Promise<void>; incr(key: string): Promise<number>; disconnect(): void };
  const Redis = createRequire(join(__dirname, "../apps/api/package.json"))("ioredis") as new (url: string, opts: object) => RedisLike;
  const redis = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await redis.connect();
    await redis.incr(`perm:v:${tenantId}`);
  } catch (err) {
    console.warn(`Could not reach Redis to refresh cached permissions (${err instanceof Error ? err.message : err}); they refresh within an hour.`);
  } finally {
    redis.disconnect();
  }
}

export async function provisionFromCli(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      code: { type: "string" },
      name: { type: "string" },
      type: { type: "string", default: "direct" },
      timezone: { type: "string", default: "UTC" },
      "admin-email": { type: "string" },
      "hq-campus-name": { type: "string" },
    },
  });
  if (!values.code || !values.name || !values["admin-email"]) {
    throw new Error("usage: pnpm provision --code <code> --name <name> --admin-email <email> [--type direct|franchise] [--timezone <tz>]");
  }
  const owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
  try {
    const service = new ProvisioningService(owner, await KeycloakAdmin.connect());
    const result = await service.provision({
      code: values.code,
      name: values.name,
      type: values.type as TenantType,
      timezone: values.timezone,
      adminEmail: values["admin-email"],
      hqCampusName: values["hq-campus-name"],
    });
    await invalidatePermissionCache(result.tenantId);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await owner.$disconnect();
  }
}

if (require.main === module) {
  loadLocalEnv();
  provisionFromCli(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
