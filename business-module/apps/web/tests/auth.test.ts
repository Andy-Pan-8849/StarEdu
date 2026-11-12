import { describe, expect, it, vi } from "vitest";
import { entryParams, realmFor, safeReturnPath, tenantCodeFromHost } from "../src/lib/auth/host";
import { authorizeUrl, exchangeCode, logoutUrl, OidcError, refreshTokens } from "../src/lib/auth/oidc";
import { challengeFor, randomToken } from "../src/lib/auth/pkce";
import { freshSession, loadSession } from "../src/lib/auth/server-session";
import type { SessionStore, WebSession } from "../src/lib/auth/session-store";
import { sign, verify } from "../src/lib/auth/signed-cookie";
import { webAuthConfig } from "../src/lib/auth/config";

describe("host and entry rules", () => {
  it("takes the tenant only from the host name", () => {
    expect(tenantCodeFromHost("hq.localhost:3001")).toBe("hq");
    expect(tenantCodeFromHost("franchise.staredu.com")).toBe("franchise");
    expect(tenantCodeFromHost("platform.localhost:3001")).toBeNull();
    expect(tenantCodeFromHost("localhost:3001")).toBeNull();
    expect(tenantCodeFromHost("10.0.0.5:3001")).toBeNull();
    expect(tenantCodeFromHost(undefined)).toBeNull();
    expect(realmFor("hq")).toBe("tenant-hq");
  });

  it("uses the admin client under /admin and the portal client at the root", () => {
    expect(entryParams("admin")).toEqual({ clientId: "admin", base: "/admin" });
    expect(entryParams("portal")).toEqual({ clientId: "portal", base: "" });
  });

  it("only returns to local paths inside the entry (no open redirects, no auth loops)", () => {
    expect(safeReturnPath("/admin/system", "admin")).toBe("/admin/system");
    expect(safeReturnPath("/admin", "admin")).toBe("/admin");
    expect(safeReturnPath("https://evil.example/", "admin")).toBe("/admin");
    expect(safeReturnPath("//evil.example/", "admin")).toBe("/admin");
    expect(safeReturnPath("/\\evil.example", "portal")).toBe("/");
    expect(safeReturnPath("/other", "admin")).toBe("/admin");
    expect(safeReturnPath("/administrator", "admin")).toBe("/admin");
    expect(safeReturnPath("/admin/auth/login", "admin")).toBe("/admin");
    expect(safeReturnPath("/bff/me", "portal")).toBe("/");
    expect(safeReturnPath(null, "portal")).toBe("/");
    expect(safeReturnPath("/courses", "portal")).toBe("/courses");
  });
});

describe("PKCE and signed cookies", () => {
  it("matches the RFC 7636 test vector", () => {
    expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(randomToken(32)).not.toBe(randomToken(32));
    expect(randomToken(48).length).toBeGreaterThanOrEqual(64);
  });

  it("verifies what it signed and nothing else", () => {
    const token = sign({ state: "s", verifier: "v" }, "secret");
    expect(verify(token, "secret")).toEqual({ state: "s", verifier: "v" });
    expect(verify(token, "other-secret")).toBeNull();
    const [payload, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ state: "evil", verifier: "v" })).toString("base64url");
    expect(verify(`${forged}.${mac}`, "secret")).toBeNull();
    expect(verify(`${payload}.`, "secret")).toBeNull();
    expect(verify(`${payload}.x.y`, "secret")).toBeNull();
    expect(verify(undefined, "secret")).toBeNull();
    expect(verify("garbage", "secret")).toBeNull();
  });
});

describe("OIDC requests", () => {
  const base = { publicUrl: "http://localhost:8180", tenantCode: "hq", origin: "http://hq.localhost:3001" };

  it("builds an authorization-code + PKCE (S256) URL for the right realm, client and callback", () => {
    const url = new URL(authorizeUrl({ ...base, entry: "admin", state: "st", verifier: "ver" }));
    expect(url.pathname).toBe("/realms/tenant-hq/protocol/openid-connect/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "admin",
      response_type: "code",
      scope: "openid",
      redirect_uri: "http://hq.localhost:3001/admin/auth/callback",
      state: "st",
      code_challenge: challengeFor("ver"),
      code_challenge_method: "S256",
    });
    expect(new URL(authorizeUrl({ ...base, entry: "portal", state: "s", verifier: "v" })).searchParams.get("redirect_uri")).toBe("http://hq.localhost:3001/auth/callback");
  });

  it("builds the logout URL that returns to the sign-in route of the same entry", () => {
    const url = new URL(logoutUrl({ ...base, entry: "admin" }));
    expect(url.pathname).toBe("/realms/tenant-hq/protocol/openid-connect/logout");
    expect(url.searchParams.get("post_logout_redirect_uri")).toBe("http://hq.localhost:3001/admin/auth/login");
    expect(url.searchParams.get("id_token_hint")).toBeNull();
    expect(new URL(logoutUrl({ ...base, entry: "admin", idToken: "tok" })).searchParams.get("id_token_hint")).toBe("tok"); // 带上就不弹确认页
  });

  it("exchanges the code with the verifier and computes absolute expiry times", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: "A", refresh_token: "R", id_token: "I", expires_in: 900, refresh_expires_in: 1800 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const tokens = await exchangeCode({ keycloakUrl: "http://kc", tenantCode: "hq", entry: "admin", origin: base.origin, code: "c", verifier: "v", now: 1_000 });
      expect(tokens).toEqual({ accessToken: "A", refreshToken: "R", idToken: "I", accessExpiresAt: 901_000, refreshExpiresAt: 1_801_000 });
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("http://kc/realms/tenant-hq/protocol/openid-connect/token");
      expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({ grant_type: "authorization_code", client_id: "admin", code: "c", redirect_uri: "http://hq.localhost:3001/admin/auth/callback", code_verifier: "v" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("raises an error when the identity service refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
    try {
      await expect(refreshTokens({ keycloakUrl: "http://kc", tenantCode: "hq", entry: "portal", refreshToken: "r" })).rejects.toBeInstanceOf(OidcError);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

class MemoryStore implements SessionStore {
  readonly map = new Map<string, WebSession>();
  async create(s: WebSession) { this.map.set("sid-1", s); return "sid-1"; }
  async get(id: string) { return this.map.get(id) ?? null; }
  async update(id: string, s: WebSession) { this.map.set(id, s); }
  async delete(id: string) { this.map.delete(id); }
}

describe("session loading and refreshing", () => {
  const session = (over: Partial<WebSession> = {}): WebSession => ({
    tenantCode: "hq", entry: "admin", accessToken: "A1", refreshToken: "R1", accessExpiresAt: 1_000_000, refreshExpiresAt: 2_000_000, ...over,
  });

  it("returns nothing for a missing cookie, an unknown session, or a session of another entry", async () => {
    const store = new MemoryStore();
    store.map.set("sid-1", session());
    expect(await loadSession(undefined, "admin", store)).toBeNull();
    expect(await loadSession("nope", "admin", store)).toBeNull();
    expect(await loadSession("sid-1", "portal", store)).toBeNull();
    expect((await loadSession("sid-1", "admin", store))?.session.accessToken).toBe("A1");
  });

  it("keeps a still-valid access token, refreshes one about to expire, and drops the session when refreshing fails", async () => {
    const store = new MemoryStore();
    store.map.set("sid-1", session());
    const refresh = vi.fn(async () => ({ accessToken: "A2", refreshToken: "R2", accessExpiresAt: 1_900_000, refreshExpiresAt: 2_900_000 }));
    const live = { id: "sid-1", session: session() };

    expect((await freshSession(live, store, 100_000, "http://kc", refresh))?.session.accessToken).toBe("A1");
    expect(refresh).not.toHaveBeenCalled();

    const renewed = await freshSession(live, store, 990_000, "http://kc", refresh);
    expect(renewed?.session).toMatchObject({ accessToken: "A2", refreshToken: "R2" });
    expect(store.map.get("sid-1")?.accessToken).toBe("A2"); // 新令牌写回了会话

    const failing = vi.fn(async () => { throw new Error("session ended"); });
    expect(await freshSession(live, store, 990_000, "http://kc", failing)).toBeNull();
    expect(store.map.has("sid-1")).toBe(false); // 被强退/刷新令牌失效：会话删除
  });

  it("an expired refresh token ends the session without calling the identity service", async () => {
    const store = new MemoryStore();
    store.map.set("sid-1", session());
    const refresh = vi.fn();
    expect(await freshSession({ id: "sid-1", session: session() }, store, 2_500_000, "http://kc", refresh)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    expect(store.map.has("sid-1")).toBe(false);
  });
});

describe("config", () => {
  it("refuses to start in production without a session secret", () => {
    expect(() => webAuthConfig({ NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv)).toThrow(/WEB_SESSION_SECRET/);
    expect(webAuthConfig({ NODE_ENV: "production", WEB_SESSION_SECRET: "x" } as unknown as NodeJS.ProcessEnv).secret).toBe("x");
    expect(webAuthConfig({} as NodeJS.ProcessEnv).keycloakPublicUrl).toBe("http://localhost:8180");
  });
});
