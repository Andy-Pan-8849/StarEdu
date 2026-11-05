/**
 * 文件：playwright.config.ts
 * 作用：端到端测试配置：针对 Compose 栈（web 3000、API 8000、Keycloak 8080），
 * 串行单进程运行，只用 Chromium，失败时保留 trace。地址可用 E2E_* 环境变量覆盖。
 */

import { defineConfig, devices } from "@playwright/test";

// Runs against the Compose stack (make up): web on 3000, API on 8000, Keycloak on 8080.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_WEB_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
