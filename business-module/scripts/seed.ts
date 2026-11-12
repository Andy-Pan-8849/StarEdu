// 本地演示数据：开通两个租户——直营集团 hq（总部校区"StarIT北京总部"）和加盟商 riverside-franchise（StarIT-RiverSide，中文名 StarIT 河岸教育）。可重复运行。
import { provisionFromCli } from "./provision-tenant";
import { loadLocalEnv } from "./lib/keycloak";

async function main(): Promise<void> {
  loadLocalEnv();
  await provisionFromCli(["--code", "hq", "--name", "StarIT", "--hq-campus-name", "StarIT北京总部", "--admin-email", "admin@hq.example.test"]);
  await provisionFromCli([
    "--code", "riverside-franchise",
    "--name", "StarIT-RiverSide",
    "--type", "franchise",
    "--admin-email", "admin@riverside-franchise.example.test",
  ]);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
