// 与 Keycloak 的授权码 + PKCE 往返。纯函数加 fetch，便于测试。
import { challengeFor } from "./pkce";
import { entryParams, realmFor, type Entry } from "./host";

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** 退出登录时作为 id_token_hint，Keycloak 就不再弹"确认退出"页面 */
  idToken?: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

export class OidcError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** 登录时顺带要求的动作：改密码（Keycloak 的"应用发起的动作"，登录后先让用户设新密码再回来）。 */
export const KC_ACTIONS = { password: "UPDATE_PASSWORD" } as const;

export function authorizeUrl(opts: { publicUrl: string; tenantCode: string; entry: Entry; origin: string; state: string; verifier: string; kcAction?: keyof typeof KC_ACTIONS }): string {
  const { clientId, base } = entryParams(opts.entry);
  const url = new URL(`${opts.publicUrl}/realms/${realmFor(opts.tenantCode)}/protocol/openid-connect/auth`);
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    scope: "openid",
    redirect_uri: `${opts.origin}${base}/auth/callback`,
    state: opts.state,
    code_challenge: challengeFor(opts.verifier),
    code_challenge_method: "S256",
    ...(opts.kcAction ? { kc_action: KC_ACTIONS[opts.kcAction] } : {}),
  }).toString();
  return url.toString();
}

export function logoutUrl(opts: { publicUrl: string; tenantCode: string; entry: Entry; origin: string; idToken?: string }): string {
  const { clientId, base } = entryParams(opts.entry);
  const url = new URL(`${opts.publicUrl}/realms/${realmFor(opts.tenantCode)}/protocol/openid-connect/logout`);
  const params = new URLSearchParams({ client_id: clientId, post_logout_redirect_uri: `${opts.origin}${base}/auth/login` });
  if (opts.idToken) params.set("id_token_hint", opts.idToken);
  url.search = params.toString();
  return url.toString();
}

async function tokenRequest(keycloakUrl: string, tenantCode: string, params: Record<string, string>, now: number): Promise<TokenSet> {
  const res = await fetch(`${keycloakUrl}/realms/${realmFor(tenantCode)}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new OidcError(`token request failed: ${res.status}`, res.status);
  const body = (await res.json()) as { access_token: string; refresh_token: string; id_token?: string; expires_in: number; refresh_expires_in?: number };
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    ...(body.id_token ? { idToken: body.id_token } : {}),
    accessExpiresAt: now + body.expires_in * 1000,
    refreshExpiresAt: now + (body.refresh_expires_in ?? 1800) * 1000,
  };
}

export function exchangeCode(opts: { keycloakUrl: string; tenantCode: string; entry: Entry; origin: string; code: string; verifier: string; now?: number }): Promise<TokenSet> {
  const { clientId, base } = entryParams(opts.entry);
  return tokenRequest(
    opts.keycloakUrl,
    opts.tenantCode,
    { grant_type: "authorization_code", client_id: clientId, code: opts.code, redirect_uri: `${opts.origin}${base}/auth/callback`, code_verifier: opts.verifier },
    opts.now ?? Date.now(),
  );
}

export function refreshTokens(opts: { keycloakUrl: string; tenantCode: string; entry: Entry; refreshToken: string; now?: number }): Promise<TokenSet> {
  return tokenRequest(
    opts.keycloakUrl,
    opts.tenantCode,
    { grant_type: "refresh_token", client_id: entryParams(opts.entry).clientId, refresh_token: opts.refreshToken },
    opts.now ?? Date.now(),
  );
}
