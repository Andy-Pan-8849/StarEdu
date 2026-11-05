/**
 * 文件：lib/config.ts
 * 作用：前端的配置：API 地址、OIDC 认证服务地址、客户端 ID。
 * 说明：这些值来自 NEXT_PUBLIC_ 开头的环境变量，是在**构建时**写进前端代码的；
 * 部署到别的地址要改变量后重新构建。未设置时用本地开发默认值。
 */

export const config = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000",
  oidcAuthority: process.env.NEXT_PUBLIC_OIDC_AUTHORITY ?? "http://localhost:8080/realms/starit",
  oidcClientId: process.env.NEXT_PUBLIC_OIDC_CLIENT_ID ?? "starit-web",
};
