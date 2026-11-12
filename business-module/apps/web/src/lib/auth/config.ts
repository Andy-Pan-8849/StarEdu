// 登录相关的服务端配置（只在服务端读取，不进浏览器）。
export interface WebAuthConfig {
  /** 服务端访问 Keycloak 的地址（换令牌） */
  keycloakUrl: string;
  /** 浏览器访问 Keycloak 的地址（跳转登录页）；通常与上面相同，容器里部署时才不同 */
  keycloakPublicUrl: string;
  apiUrl: string;
  redisUrl: string;
  /** 给 OIDC 往返 cookie 签名的密钥 */
  secret: string;
}

export function webAuthConfig(env: NodeJS.ProcessEnv = process.env): WebAuthConfig {
  const keycloakUrl = env.KEYCLOAK_URL ?? "http://localhost:8180";
  const secret = env.WEB_SESSION_SECRET ?? (env.NODE_ENV === "production" ? "" : "dev-only-secret-change-me");
  if (!secret) throw new Error("WEB_SESSION_SECRET must be set in production");
  return {
    keycloakUrl,
    keycloakPublicUrl: env.KEYCLOAK_PUBLIC_URL ?? keycloakUrl,
    apiUrl: env.API_URL ?? `http://localhost:${env.API_PORT ?? "4000"}`,
    redisUrl: env.REDIS_URL ?? "redis://localhost:6380/0",
    secret,
  };
}
