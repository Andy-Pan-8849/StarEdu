/**
 * 文件：next.config.ts
 * 作用：Next.js 配置。output=standalone 生成可独立运行的最小产物（Docker 镜像用它）；
 * 开启 React 严格模式；去掉 X-Powered-By 响应头。
 */

import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
};

export default config;
