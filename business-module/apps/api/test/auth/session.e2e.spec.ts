// 会话相关（真实 Keycloak 令牌）：令牌里有 sid、在线用户、强退、停用账号、登录登记与入口资格、令牌跨租户。
import { claimsOf, Harness } from "../helpers/app";

describe("sessions, force logout and entry qualification", () => {
  const h = new Harness();
  let boss: Awaited<ReturnType<Harness["user"]>>;
  let bossToken: string;

  beforeAll(async () => {
    await h.start();
    boss = await h.user("boss", { roles: ["tenant-admin"], person: "staff" });
    bossToken = await boss.token();
  });
  afterAll(() => h.stop());

  const waitFor = async <T>(fn: () => Promise<T | undefined | false>): Promise<T> => {
    for (let i = 0; i < 20; i += 1) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("condition not met in time");
  };

  it("the access token carries the claims the API relies on, including sid", () => {
    const c = claimsOf(bossToken);
    expect(c).toMatchObject({ tenant_id: h.tenant.tenantId, account_id: boss.accountId });
    expect(typeof c.sid).toBe("string"); // 强退和在线用户都靠它
    expect(c.exp as number - (c.iat as number)).toBe(900);
  });

  it("/api/me carries the brand: the company's short name (or name) and an optional, validated logo URL", async () => {
    const me = async () => (await h.call(bossToken).get("/api/me")).body.brand as { name: string; logoUrl: string | null };
    const tenant = await h.owner.tenant.findUniqueOrThrow({ where: { id: h.tenant.tenantId } });
    expect(await me()).toEqual({ name: tenant.name, logoUrl: null });
    await h.owner.tenant.update({ where: { id: tenant.id }, data: { shortName: "RiverSide" } });
    const param = (value: string) => h.owner.sysParam.upsert({ where: { tenantId_key: { tenantId: tenant.id, key: "brand.logoUrl" } }, update: { value }, create: { tenantId: tenant.id, key: "brand.logoUrl", value, name: "Logo" } });
    await param("https://cdn.example.test/logo.png");
    expect(await me()).toEqual({ name: "RiverSide", logoUrl: "https://cdn.example.test/logo.png" });
    await param("javascript:alert(1)"); // 不合规的地址被忽略，回到默认 Logo
    expect((await me()).logoUrl).toBeNull();
  });

  it("a signed-in user shows up as online, and an administrator can force them out", async () => {
    const victim = await h.user("victim", { roles: ["tenant-admin"], person: "staff" });
    const victimToken = await victim.token();
    const sid = claimsOf(victimToken).sid as string;
    expect((await h.call(victimToken).get("/api/me")).status).toBe(200);

    const session = await waitFor(async () => (await h.call(bossToken).get("/api/online")).body.find((s: { sid: string }) => s.sid === sid));
    expect(session).toMatchObject({ accountId: victim.accountId, username: "victim" });

    const out = await h.call(bossToken).del(`/api/online/${sid}`);
    expect(out.status).toBe(200);
    expect(out.body.keycloakEnded).toBe(true);
    expect((await h.call(victimToken).get("/api/me")).status).toBe(401); // 令牌还没过期，但会话已被拒绝
    expect((await h.call(bossToken).get("/api/online")).body.some((s: { sid: string }) => s.sid === sid)).toBe(false);
    expect((await h.call(bossToken).del(`/api/online/${sid}`)).status).toBe(404); // 再强退一次：没有这个会话

    // 强退被记入操作日志
    const logs = (await h.call(bossToken).get("/api/audit-logs")).body as Array<{ action: string; targetId: string }>;
    expect(logs.some((l) => l.action === "session.forceLogout" && l.targetId === sid)).toBe(true);
    // Keycloak 里的会话也被结束了：刷新令牌不能再用（这里验证该会话已不在 Keycloak 里）
    const kcSessions = await h.keycloak.request(`/realms/${h.realm}/users/${(await h.owner.account.findUniqueOrThrow({ where: { id: victim.accountId } })).keycloakUserId}/sessions`);
    expect(((await kcSessions.json()) as Array<{ id: string }>).some((s) => s.id === sid)).toBe(false);
  });

  it("an account without the permission cannot see or end sessions", async () => {
    const nobody = await h.user("nobody");
    const token = await nobody.token();
    expect((await h.call(token).get("/api/online")).status).toBe(403);
    expect((await h.call(token).del("/api/online/whatever")).status).toBe(403);
  });

  it("disabling an account takes effect on its very next request, and re-enabling restores it", async () => {
    const target = await h.user("target", { roles: ["tenant-admin"], person: "staff" });
    const token = await target.token();
    expect((await h.call(token).get("/api/me")).status).toBe(200);

    const res = await h.call(bossToken).patch(`/api/accounts/${target.accountId}/status`, { status: "disabled" });
    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(true);
    expect((await h.call(token).get("/api/me")).status).toBe(403);
    const kcId = (await h.owner.account.findUniqueOrThrow({ where: { id: target.accountId } })).keycloakUserId as string;
    expect((await h.keycloak.getUser(h.realm, kcId))?.enabled).toBe(false); // 推送给了 Keycloak

    expect((await h.call(bossToken).patch(`/api/accounts/${target.accountId}/status`, { status: "active" })).status).toBe(200);
    expect((await h.call(token).get("/api/me")).status).toBe(200);
    expect((await h.keycloak.getUser(h.realm, kcId))?.enabled).toBe(true);
  });

  it("the built-in administrator cannot be disabled, and you cannot disable yourself", async () => {
    const builtin = await h.owner.account.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, isBuiltinAdmin: true } });
    expect((await h.call(bossToken).patch(`/api/accounts/${builtin.id}/status`, { status: "disabled" })).status).toBe(403);
    expect((await h.call(bossToken).patch(`/api/accounts/${boss.accountId}/status`, { status: "disabled" })).status).toBe(403);
  });

  describe("login registration and entry qualification", () => {
    it("staff enter the admin console: a login log is written, the menu tree comes back, a pending account becomes active", async () => {
      const staff = await h.user("pending.staff", { roles: ["hr-manager"], person: "staff", status: "pending" });
      const token = await staff.token();
      // 待激活：只能用"任何已登录账号"的接口，业务接口一律拒绝
      expect((await h.call(token).get("/api/persons")).status).toBe(403);
      const res = await h.call(token).post("/api/auth/session", { entry: "admin" });
      expect(res.status).toBe(201);
      expect(res.body.permissions).toEqual(expect.arrayContaining(["hr:person:list", "hr:person:edit"]));
      const top = res.body.menus.map((m: { code: string }) => m.code);
      expect(top).toEqual(["hr", "doc", "ai"]); // hr-manager 勾选了人事、文档库和 AI 助手；没有勾选的"系统管理"不出现
      expect(res.body.menus[0].children.map((m: { code: string }) => m.code)).toEqual(["hr:person", "hr:staff", "hr:student"]);
      expect((await h.owner.account.findUniqueOrThrow({ where: { id: staff.accountId } })).status).toBe("active");
      expect((await h.call(token).get("/api/persons")).status).toBe(200); // 激活后立即生效
      const log = await h.owner.loginLog.findFirstOrThrow({ where: { accountId: staff.accountId }, orderBy: { createdAt: "desc" } });
      expect(log).toMatchObject({ entry: "admin", result: "success" });
    });

    it("a student cannot enter the admin console, and the denial is logged", async () => {
      const student = await h.user("some.student", { roles: ["student"], person: "student" });
      const token = await student.token();
      const res = await h.call(token).post("/api/auth/session", { entry: "admin" });
      expect(res.status).toBe(403);
      const log = await h.owner.loginLog.findFirstOrThrow({ where: { accountId: student.accountId }, orderBy: { createdAt: "desc" } });
      expect(log).toMatchObject({ entry: "admin", result: "denied" });
      expect(log.reason).toMatch(/staff/i);
      expect((await h.call(token).get("/api/me/menus?entry=admin")).status).toBe(403);
      // 学生可以进门户（此时门户还没有菜单）
      expect((await h.call(token).post("/api/auth/session", { entry: "portal" })).status).toBe(201);
    });

    it("staff cannot enter the student portal; staff with no menus cannot enter the admin console", async () => {
      expect((await h.call(bossToken).post("/api/auth/session", { entry: "portal" })).status).toBe(403);
      const empty = await h.user("empty.staff", { person: "staff" }); // 没有任何角色 = 没有勾选任何菜单
      expect((await h.call(await empty.token()).post("/api/auth/session", { entry: "admin" })).status).toBe(403);
    });

    it("the built-in administrator may enter the admin console without a person record and sees all enabled menus", async () => {
      const builtin = await h.owner.account.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, isBuiltinAdmin: true } });
      // 内置管理员在 Keycloak 里还没设密码（邀请未点）；测试里给它设一个密码来换令牌
      await h.keycloak.request(`/realms/${h.realm}/users/${builtin.keycloakUserId}/reset-password`, {
        method: "PUT",
        body: JSON.stringify({ type: "password", value: "Str0ng!Passw0rd", temporary: false }),
      });
      const res = await fetch(`${h.keycloak.url}/realms/${h.realm}/protocol/openid-connect/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "password", client_id: "portal", username: "admin", password: "Str0ng!Passw0rd" }),
      });
      expect(res.ok).toBe(true);
      const token = ((await res.json()) as { access_token: string }).access_token;
      expect((await h.call(token).get("/api/persons")).status).toBe(403); // 账号还是"待激活"
      const session = await h.call(token).post("/api/auth/session", { entry: "admin" });
      expect(session.status).toBe(201);
      expect(session.body.menus.map((m: { code: string }) => m.code).sort()).toEqual(["ai", "doc", "edu", "hr", "msg", "system"]);
    });
  });

  it("a token from another tenant's realm is refused here (A's token on B's host)", async () => {
    const other = await h.extraTenant();
    expect((await h.call(bossToken, `${other.code}.localhost`).get("/api/me")).status).toBe(401);
  });
});
