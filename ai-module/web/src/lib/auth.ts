/**
 * 文件：lib/auth.ts
 * 作用：浏览器端的登录（OIDC，授权码 + PKCE 流程，对接 Keycloak）。
 * 主要思想：令牌只保存在当前标签页的 sessionStorage 里（关掉标签页就没了，
 *   也不会被别的标签页读到）；
 * 开启自动续期。登录后只允许回到本站内的路径，防止“开放重定向”攻击。
 */

import { UserManager, WebStorageStateStore } from "oidc-client-ts";
import { config } from "@/lib/config";

let manager: UserManager | null = null;

/**
 * 取（必要时创建）全局唯一的 OIDC 管理器。浏览器端 OIDC：授权码 + PKCE，令牌留在本标签页的
 *   sessionStorage。
 */
export function getManager(): UserManager {
  if (manager === null) {
    manager = new UserManager({
      authority: config.oidcAuthority,
      client_id: config.oidcClientId,
      redirect_uri: `${window.location.origin}/callback`,
      post_logout_redirect_uri: window.location.origin,
      response_type: "code",
      scope: "openid profile",
      userStore: new WebStorageStateStore({ store: window.sessionStorage }),
      automaticSilentRenew: true,
    });
  }
  return manager;
}

/**
 * 登录后要回到的路径：只接受以单个 / 开头的站内路径，其他一律回首页（防开放重定向）。
 */
export function safeReturnPath(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : "/";
}

/**
 * 能管理知识库文档的角色名。
 */
export const MANAGEMENT_ROLE = "RAGETLAdmin";

/**
 * 这些角色里有没有文档管理角色（决定是否显示 Documents 页入口）。
 */
export function canManageDocuments(roles: readonly string[]): boolean {
  return roles.includes(MANAGEMENT_ROLE);
}
