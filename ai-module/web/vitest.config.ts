/**
 * 文件：vitest.config.ts
 * 作用：单元测试配置：用 jsdom 模拟浏览器，@ 别名指向 src，测试文件在 tests/ 下，全局注入
 *   describe/it 等。
 */

import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    globals: true,
  },
});
