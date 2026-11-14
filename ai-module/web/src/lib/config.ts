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

/**
 * 业务模式：每个租户一个登录域（tenant-<租户代码>），租户代码取自访问的域名第一段
 * （hq.localhost:3000 -> tenant-hq）。设置了 NEXT_PUBLIC_TENANT_REALM_BASE 才启用；
 * 没设置时沿用上面的单一登录域（独立模式，行为不变）。
 */
const TENANT_CODE = /^[a-z][a-z0-9-]{1,30}$/;

export function oidcFor(hostname: string): { authority: string; clientId: string } {
  const base = process.env.NEXT_PUBLIC_TENANT_REALM_BASE ?? "";
  if (!base) return { authority: config.oidcAuthority, clientId: config.oidcClientId };
  const labels = hostname.split(".");
  const code = labels[0] ?? "";
  // 和业务模块认租户的规则一致：至少两段（localhost 这样的单段主机名没有租户），第一段是租户代码
  if (labels.length < 2 || !TENANT_CODE.test(code)) {
    throw new Error(
      "This address does not belong to a company; open the assistant from your company's address.",
    );
  }
  const prefix = process.env.NEXT_PUBLIC_TENANT_REALM_PREFIX ?? "tenant-";
  return {
    authority: `${base.replace(/\/+$/, "")}/${prefix}${code}`,
    clientId: process.env.NEXT_PUBLIC_TENANT_CLIENT_ID ?? "ai",
  };
}
