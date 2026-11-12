// 脚本共用：读取本地 .env（已存在的环境变量不覆盖）。Keycloak 封装在 apps/api/src/keycloak。
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function loadLocalEnv(): void {
  for (const name of [".env", ".env.example"]) {
    const file = resolve(__dirname, "../..", name);
    if (existsSync(file)) {
      process.loadEnvFile(file);
      return;
    }
  }
}
