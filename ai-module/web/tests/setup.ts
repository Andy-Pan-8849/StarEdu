/**
 * 文件：tests/setup.ts
 * 作用：Vitest 的全局准备：引入 jest-dom 的断言扩展（toBeInTheDocument 等），
 *   并在每个测试后清理渲染出的 DOM。
 */

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());
