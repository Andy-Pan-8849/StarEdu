import { afterEach } from "vitest";

// 只有 jsdom 环境的测试需要清理渲染出来的 DOM
afterEach(async () => {
  if (typeof document !== "undefined") {
    const { cleanup } = await import("@testing-library/react");
    cleanup();
  }
});
