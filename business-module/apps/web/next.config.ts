import createNextIntlPlugin from "next-intl/plugin";
import type { NextConfig } from "next";

// 语言不放进网址（保持 `/` 是学生门户、`/admin` 是管理后台），由 cookie 决定，见 src/i18n/request.ts。
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // 租户网址形如 hq.localhost:3001，开发时放行这些来源
  allowedDevOrigins: ["*.localhost"],
};

export default withNextIntl(nextConfig);
