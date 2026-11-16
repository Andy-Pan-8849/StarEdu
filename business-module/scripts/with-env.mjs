/* global process, console */
// 先把 .env 读进环境变量（不经过 shell，不执行里面的任何内容），再运行后面的命令：
//   node scripts/with-env.mjs pnpm --filter @staredu/api dev
// 已经在环境里的变量优先（和 dotenv 的默认行为一致）。需要 Node 20.12 以上（process.loadEnvFile）。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: node scripts/with-env.mjs <command> [args...]");
  process.exit(2);
}
const file = resolve(process.cwd(), ".env");
if (existsSync(file)) process.loadEnvFile(file);
else console.warn(`.env not found in ${process.cwd()}; using the current environment only`);

const child = spawn(command, args, { stdio: "inherit", env: process.env, shell: process.platform === "win32" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
