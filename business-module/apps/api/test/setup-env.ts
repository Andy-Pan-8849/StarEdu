// 本地跑测试时读取 business-module/.env（没有就读 .env.example）；CI 里变量已由环境提供，不覆盖。
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

for (const name of [".env", ".env.example"]) {
  const file = resolve(__dirname, "../../..", name);
  if (existsSync(file)) {
    for (const [key, value] of Object.entries(parseEnv(file))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
    break;
  }
}

function parseEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2];
  }
  return out;
}

// 测试里不跑后台轮询；需要时直接调用 NotifyWorker.tick()
process.env.NOTIFY_WORKER = "off";
