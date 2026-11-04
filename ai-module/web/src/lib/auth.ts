import { UserManager, WebStorageStateStore } from "oidc-client-ts";
import { config } from "@/lib/config";

let manager: UserManager | null = null;

/** Browser-side OIDC (authorization code + PKCE). Tokens stay in this tab's sessionStorage. */
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

/** Only same-site paths may be returned to after sign-in (no open redirect). */
export function safeReturnPath(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : "/";
}

export const MANAGEMENT_ROLE = "RAGETLAdmin";

export function canManageDocuments(roles: readonly string[]): boolean {
  return roles.includes(MANAGEMENT_ROLE);
}
