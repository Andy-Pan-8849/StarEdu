// 本地演示数据：开通两个租户——直营总部 hq 和一个加盟商 franchise。可重复运行。
import { provisionFromCli } from "./provision-tenant";
import { loadLocalEnv } from "./lib/keycloak";

async function main(): Promise<void> {
  loadLocalEnv();
  await provisionFromCli(["--code", "hq", "--name", "StarIT", "--admin-email", "admin@hq.example.test"]);
  await provisionFromCli([
    "--code", "franchise",
    "--name", "StarIT Franchise",
    "--type", "franchise",
    "--admin-email", "admin@franchise.example.test",
  ]);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
