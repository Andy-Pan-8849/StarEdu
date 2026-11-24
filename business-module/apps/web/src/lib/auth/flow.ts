// 登录、回调、退出三个动作（门户和后台共用，入口不同客户端和回调路径不同）。
import { NextRequest, NextResponse } from "next/server";
import { callApi } from "./api-client";
import { webAuthConfig } from "./config";
import { entryParams, isPlatformHostName, PLATFORM_REALM_CODE, safeReturnPath, tenantCodeFromHost, type Entry } from "./host";
import { authorizeUrl, exchangeCode, logoutUrl } from "./oidc";
import { randomToken } from "./pkce";
import { OIDC_COOKIE, SESSION_COOKIE } from "./server-session";
import { sessionStore } from "./session-store";
import { sign, verify } from "./signed-cookie";

interface OidcState {
  state: string;
  verifier: string;
  entry: Entry;
  tenantCode: string;
  returnTo: string;
}

function origin(req: NextRequest): { origin: string; host: string; secure: boolean } {
  const host = req.headers.get("host") ?? req.nextUrl.host;
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  return { origin: `${proto}://${host}`, host, secure: proto === "https" };
}

const cookieOptions = (secure: boolean, maxAge: number) => ({ httpOnly: true, sameSite: "lax" as const, secure, path: "/", maxAge });

function page(status: number, title: string, message: string, link: { href: string; label: string }): NextResponse {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.4rem">${title}</h1><p>${message}</p><p><a href="${link.href}">${link.label}</a></p></body>`;
  return new NextResponse(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function handleAuth(entry: Entry, action: string, req: NextRequest): Promise<NextResponse> {
  const config = webAuthConfig();
  const { origin: self, host, secure } = origin(req);
  // 平台入口只在平台主机上登录，租户入口只在租户主机上登录
  if ((entry === "platform") !== isPlatformHostName(host)) return new NextResponse("Not found", { status: 404 });
  const tenantCode = entry === "platform" ? PLATFORM_REALM_CODE : tenantCodeFromHost(host);
  const { base } = entryParams(entry);
  if (!tenantCode) return new NextResponse("Unknown tenant", { status: 404 });

  if (action === "login") {
    const state = randomToken(24);
    const verifier = randomToken(48);
    const returnTo = safeReturnPath(req.nextUrl.searchParams.get("return"), entry);
    const res = NextResponse.redirect(authorizeUrl({ publicUrl: config.keycloakPublicUrl, tenantCode, entry, origin: self, state, verifier, ...(req.nextUrl.searchParams.get("kc_action") === "password" ? { kcAction: "password" as const } : {}) }));
    res.cookies.set(OIDC_COOKIE, sign({ state, verifier, entry, tenantCode, returnTo } satisfies OidcState, config.secret), cookieOptions(secure, 600));
    return res;
  }

  if (action === "callback") {
    const saved = verify<OidcState>(req.cookies.get(OIDC_COOKIE)?.value, config.secret);
    const params = req.nextUrl.searchParams;
    const again = { href: `${base}/auth/login`, label: "Sign in again" };
    if (!saved || saved.entry !== entry || saved.tenantCode !== tenantCode || saved.state !== params.get("state")) {
      return page(400, "Sign-in failed", "The sign-in request could not be verified. Please try again.", again);
    }
    const code = params.get("code");
    if (params.get("error") || !code) return page(400, "Sign-in cancelled", "The identity service did not complete the sign-in.", again);

    let tokens;
    try {
      tokens = await exchangeCode({ keycloakUrl: config.keycloakUrl, tenantCode, entry, origin: self, code, verifier: saved.verifier });
    } catch {
      return page(502, "Sign-in failed", "Could not complete the sign-in with the identity service.", again);
    }
    // 入口资格检查 + 登录日志 + 激活待激活账号：在后端完成（令牌只在服务端使用）
    const registered = await callApi({
      apiUrl: config.apiUrl,
      host,
      method: "POST",
      path: entry === "platform" ? "/api/platform/auth/session" : "/api/auth/session",
      token: tokens.accessToken,
      body: entry === "platform" ? undefined : Buffer.from(JSON.stringify({ entry })),
      contentType: "application/json",
      clientIp: req.headers.get("x-forwarded-for") ?? undefined,
      userAgent: req.headers.get("user-agent") ?? undefined,
    }).catch(() => null);
    if (!registered || registered.status !== 201) {
      const denied = registered?.status === 403;
      const res = page(
        denied ? 403 : 502,
        denied ? "No access" : "Sign-in failed",
        denied ? "This account is not allowed to use this area." : "The service is not available right now.",
        { href: logoutUrl({ publicUrl: config.keycloakPublicUrl, tenantCode, entry, origin: self }), label: "Sign out" },
      );
      res.cookies.delete(OIDC_COOKIE);
      return res;
    }
    const sid = await sessionStore(config.redisUrl).create({ tenantCode, entry, ...tokens });
    const res = NextResponse.redirect(new URL(saved.returnTo, self));
    res.cookies.set(SESSION_COOKIE, sid, cookieOptions(secure, 12 * 3600));
    res.cookies.delete(OIDC_COOKIE);
    return res;
  }

  if (action === "logout") {
    const sid = req.cookies.get(SESSION_COOKIE)?.value;
    const store = sessionStore(config.redisUrl);
    const saved = sid ? await store.get(sid) : null;
    if (sid) await store.delete(sid);
    const res = NextResponse.redirect(logoutUrl({ publicUrl: config.keycloakPublicUrl, tenantCode, entry, origin: self, idToken: saved?.idToken }));
    res.cookies.delete(SESSION_COOKIE);
    return res;
  }

  return new NextResponse("Not found", { status: 404 });
}
