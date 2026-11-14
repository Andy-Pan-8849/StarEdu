// 租户"登录与安全"：读写某个租户域的密码策略、锁定、会话、两步验证和 Google 登录（只关联已有账号）。
// 用真实的 Keycloak：设置改完后直接问 Keycloak 域确认真的生效（而不只是接口说改了）。
import { Harness } from "../helpers/app";
import { PlatformFixture, platformCall } from "../helpers/platform";

describe("tenant sign-in and security", () => {
  const h = new Harness();
  let fx: PlatformFixture;
  let token: string;
  const root = () => platformCall(h.app, token);
  const url = () => `/api/platform/tenants/${h.tenant.tenantId}/security`;
  const realmRep = async () => (await h.keycloak.getRealm(h.realm)) as Record<string, any>;

  beforeAll(async () => {
    process.env.JOBS_SCHEDULER = "off";
    await h.start();
    fx = new PlatformFixture(h.owner, h.keycloak);
    await fx.setup();
    token = await (await fx.user("p.sec", { roles: ["platform-super"] })).token();
  });
  afterAll(async () => {
    await fx.cleanup();
    await h.stop();
  });

  it("reads the template defaults", async () => {
    const res = await root().get(url());
    expect(res.status).toBe(200);
    expect(res.body.realm).toBe(h.realm);
    expect(res.body.security).toEqual({
      password: { length: 10, upperCase: 1, lowerCase: 1, digits: 1, specialChars: 1, history: 2 },
      lockout: { failureFactor: 5, waitIncrementMinutes: 10, maxWaitMinutes: 60, permanent: false },
      session: { idleMinutes: 30, maxHours: 10 },
      mfa: "off",
    });
    expect(res.body.google).toMatchObject({ configured: false, enabled: false, hasSecret: false });
  });

  it("password policy, lockout and session changes reach the realm and are enforced", async () => {
    const current = (await root().get(url())).body.security;
    const next = { ...current, password: { ...current.password, length: 14 }, lockout: { ...current.lockout, failureFactor: 3 }, session: { idleMinutes: 45, maxHours: 8 } };
    const res = await root().put(url(), next);
    expect(res.status).toBe(200);
    expect(res.body.security).toEqual(next);
    const rep = await realmRep();
    expect(rep.passwordPolicy).toContain("length(14)");
    expect(rep.passwordPolicy).toContain("notUsername"); // 不是我们管的项原样保留
    expect(rep.passwordPolicy).toContain("passwordBlacklist(common-weak.txt)");
    expect(rep.failureFactor).toBe(3);
    expect(rep.ssoSessionIdleTimeout).toBe(2700);
    expect(rep.ssoSessionMaxLifespan).toBe(28800);
    // 真的拒绝短密码（10 位够旧策略，不够新策略）
    const user = await h.user("sec.user");
    const kcUser = await h.keycloak.findUser(h.realm, user.username);
    await expect(h.keycloak.resetPassword(h.realm, kcUser!.id, "Sh0rt!Pass1", false)).rejects.toThrow(/400/);
    await h.keycloak.resetPassword(h.realm, kcUser!.id, "L0nger!Passw0rd-OK", false);
  });

  it("rejects out-of-range or inconsistent settings and unknown fields", async () => {
    const s = (await root().get(url())).body.security;
    expect((await root().put(url(), { ...s, password: { ...s.password, length: 4 } })).status).toBe(400);
    expect((await root().put(url(), { ...s, session: { idleMinutes: 600, maxHours: 2 } })).status).toBe(400);
    expect((await root().put(url(), { ...s, mfa: "sometimes" })).status).toBe(400);
    expect((await root().put(url(), { ...s, extra: 1 })).status).toBe(400);
    expect((await root().put(url(), { ...s, password: { ...s.password, length: 8, upperCase: 3, lowerCase: 3, digits: 2, specialChars: 2 } })).body.message).toMatch(/do not fit/);
  });

  it("two-step verification for everyone, and back to the default", async () => {
    const s = (await root().get(url())).body.security;
    const flow = async () => (await h.keycloak.executions(h.realm, "browser")).filter((e) => ["auth-otp-form", "conditional-user-configured"].includes(e.providerId ?? "") || e.displayName === "Browser - Conditional 2FA");
    expect((await root().put(url(), { ...s, mfa: "all" })).body.security.mfa).toBe("all");
    const on = await flow();
    expect(on.find((e) => e.providerId === "auth-otp-form")?.requirement).toBe("REQUIRED");
    expect(on.find((e) => e.displayName === "Browser - Conditional 2FA")?.requirement).toBe("REQUIRED");
    expect((await root().put(url(), { ...s, mfa: "off" })).body.security.mfa).toBe("off");
    const off = await flow();
    expect(off.find((e) => e.providerId === "auth-otp-form")?.requirement).toBe("ALTERNATIVE");
    expect(off.find((e) => e.displayName === "Browser - Conditional 2FA")?.requirement).toBe("CONDITIONAL");
  });

  it("Google: needs a secret the first time, only links existing accounts, never shows the secret, can be switched off and removed", async () => {
    const g = `${url()}/google`;
    expect((await root().put(g, { clientId: "1234567890-abc.apps.googleusercontent.com", enabled: true })).status).toBe(400);
    const created = await root().put(g, { clientId: "1234567890-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-secret-value", enabled: true });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ configured: true, enabled: true, hasSecret: true, clientId: "1234567890-abc.apps.googleusercontent.com" });
    expect(created.body.redirectUri).toMatch(new RegExp(`/realms/${h.realm}/broker/google/endpoint$`));
    expect(JSON.stringify(created.body)).not.toContain("GOCSPX");
    expect(JSON.stringify((await root().get(url())).body)).not.toContain("GOCSPX");
    const idp = await h.keycloak.getIdp(h.realm, "google");
    expect(idp).toMatchObject({ providerId: "google", trustEmail: true, firstBrokerLoginFlowAlias: "existing-account-only" });
    const execs = await h.keycloak.executions(h.realm, "existing-account-only");
    expect(execs.map((e) => [e.providerId, e.requirement])).toEqual([["idp-detect-existing-broker-user", "REQUIRED"], ["idp-auto-link", "REQUIRED"]]);
    // 不给新密钥 = 沿用旧的；只关掉
    const off = await root().put(g, { clientId: "1234567890-abc.apps.googleusercontent.com", enabled: false });
    expect(off.body).toMatchObject({ configured: true, enabled: false, hasSecret: true });
    expect((await root().del(g)).body).toMatchObject({ configured: false, hasSecret: false });
    expect(await h.keycloak.getIdp(h.realm, "google")).toBeNull();
  });

  it("every change is in the platform audit log, without the secret", async () => {
    const rows = await h.owner.platformAuditLog.findMany({ where: { targetId: h.tenant.tenantId, action: { startsWith: "tenant." } }, orderBy: { createdAt: "asc" } });
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["tenant.security", "tenant.google.create", "tenant.google.update", "tenant.google.remove"]));
    expect(JSON.stringify(rows)).not.toContain("GOCSPX");
  });

  it("needs the security permission; tenant tokens and other hosts are refused", async () => {
    const plain = await fx.user("p.plain");
    expect((await platformCall(h.app, await plain.token()).get(url())).status).toBe(403);
    expect((await platformCall(h.app, await plain.token()).put(url(), {})).status).toBe(403);
    const tenantToken = await (await h.user("sec.tadmin", { roles: ["tenant-admin"] })).token();
    expect((await platformCall(h.app, tenantToken).get(url())).status).toBe(401);
    expect((await platformCall(h.app, token, h.host).get(url())).status).toBe(403);
    expect((await root().get(`/api/platform/tenants/00000000-0000-4000-8000-000000000000/security`)).status).toBe(404);
  });
});
