// 服务端取当前登录会话；访问令牌快过期时用刷新令牌换新的；刷新失败就当作未登录。
import { webAuthConfig } from "./config";
import { type Entry } from "./host";
import { refreshTokens } from "./oidc";
import { sessionStore, type SessionStore, type WebSession } from "./session-store";

export const SESSION_COOKIE = "staredu_sid";
export const OIDC_COOKIE = "staredu_oidc";
const SKEW_MS = 30_000;

export interface LiveSession {
  id: string;
  session: WebSession;
}

export async function loadSession(sid: string | undefined, entry?: Entry, store: SessionStore = sessionStore(webAuthConfig().redisUrl)): Promise<LiveSession | null> {
  if (!sid) return null;
  const session = await store.get(sid);
  if (!session || (entry && session.entry !== entry)) return null;
  return { id: sid, session };
}

/** 访问令牌快过期就刷新；刷新失败（刷新令牌过期、会话被强退）删除会话并返回 null。 */
export async function freshSession(
  live: LiveSession,
  store: SessionStore = sessionStore(webAuthConfig().redisUrl),
  now = Date.now(),
  keycloakUrl = webAuthConfig().keycloakUrl,
  refresh: typeof refreshTokens = refreshTokens,
): Promise<LiveSession | null> {
  if (live.session.accessExpiresAt - SKEW_MS > now) return live;
  if (live.session.refreshExpiresAt <= now) {
    await store.delete(live.id);
    return null;
  }
  try {
    const tokens = await refresh({ keycloakUrl, tenantCode: live.session.tenantCode, entry: live.session.entry, refreshToken: live.session.refreshToken, now });
    const next: WebSession = { ...live.session, ...tokens, idToken: tokens.idToken ?? live.session.idToken };
    await store.update(live.id, next);
    return { id: live.id, session: next };
  } catch {
    await store.delete(live.id);
    return null;
  }
}
