// 开通一个租户（可重复运行：失败后再运行同一条命令会从断点继续）。
//   pnpm provision --code hq --name "StarIT" --admin-email admin@hq.example.test
//   pnpm provision --code franchise --name "StarIT Franchise" --type franchise --admin-email ...
import { parseArgs } from "node:util";
import { PrismaClient, TenantType } from "../apps/api/src/generated/prisma";
import { KeycloakAdmin } from "../apps/api/src/keycloak/keycloak-admin";
import { ProvisioningService } from "../apps/api/src/provisioning/provisioning.service";
import { loadLocalEnv } from "./lib/keycloak";

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
