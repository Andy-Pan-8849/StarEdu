import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // tsconfig 里 jsx 是 preserve（Next 要求），测试里要自己转换 JSX
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    // 组件测试在文件头用 `// @vitest-environment jsdom` 单独指定，其余仍在 node 里跑
    setupFiles: ["./tests/setup.ts"],
  },
});
