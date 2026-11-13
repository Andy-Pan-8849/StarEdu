// 平台入口：平台域登录与权限、租户管理（开通、状态机、功能授权、管理员页签）、平台账号与角色、
// 菜单与入口、定时任务、监控。用真实的 Postgres、Redis、Keycloak 平台域和 Mailpit。
import { randomCode, removeTestTenant } from "../helpers/fixtures";
import { Harness } from "../helpers/app";
import { PLATFORM_HOST, PlatformFixture, platformCall } from "../helpers/platform";

const MAILPIT = process.env.MAILPIT_API_URL ?? "http://localhost:8125";
async function mailTo(address: string, subjectPart = ""): Promise<boolean> {
  for (let i = 0; i < 14; i += 1) {
    const list = (await (await fetch(`${MAILPIT}/api/v1/messages`)).json()) as { messages: Array<{ To: Array<{ Address: string }>; Subject: string }> };
    if (list.messages.some((m) => m.To.some((t) => t.Address === address) && m.Subject.includes(subjectPart))) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

describe("platform console", () => {
  const h = new Harness();
  let fx: PlatformFixture;
  let rootToken: string;
  const root = () => platformCall(h.app, rootToken);
  const createdTenants: string[] = [];
  let tenantAdminToken: string;

  beforeAll(async () => {
    process.env.JOBS_SCHEDULER = "off";
    await h.start();
    fx = new PlatformFixture(h.owner, h.keycloak);
    await fx.setup();
    rootToken = await (await fx.user("p.root", { roles: ["platform-super"] })).token();
    tenantAdminToken = await (await h.user("tadmin", { roles: ["tenant-admin"], person: "staff" })).token();
  });
  afterAll(async () => {
    for (const code of createdTenants) await removeTestTenant(h.owner, h.keycloak, code);
    await fx.cleanup();
    await h.stop();
  });

  describe("sign-in and separation from tenants", () => {
    it("a platform token works on the platform host and identifies a platform super administrator", async () => {
      const me = await root().get("/api/platform/me");
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ username: "p.root", isSuper: true });
      expect(me.body.permissions).toEqual(expect.arrayContaining(["platform:tenant:add", "platform:job:run"]));
      expect(me.body.permissions.some((p: string) => p.startsWith("system:") || p.startsWith("hr:"))).toBe(false); // 平台权限与租户权限互不相通
    });

    it("tenant tokens are refused on the platform host; platform tokens are refused on tenant hosts", async () => {
      expect((await platformCall(h.app, tenantAdminToken).get("/api/platform/me")).status).toBe(401);
      expect((await platformCall(h.app, rootToken, h.host).get("/api/me")).status).toBe(401); // 租户接口：平台令牌不是该租户的
      expect((await platformCall(h.app, rootToken, h.host).get("/api/platform/me")).status).toBe(403); // 平台接口：租户主机上不可用
      expect((await platformCall(h.app, null).get("/api/platform/me")).status).toBe(401);
      expect((await platformCall(h.app, rootToken).get("/api/me")).status).toBe(403); // 租户接口在平台主机上不可用
    });

    it("the platform menu tree shows platform menus only; tenants never see platform menus", async () => {
      const tree = (await root().get("/api/platform/me/menus")).body as Array<{ code: string; children: Array<{ code: string }> }>;
      expect(tree.map((n) => n.code)).toEqual(["platform"]);
      expect(tree[0].children.map((n) => n.code)).toEqual(expect.arrayContaining(["platform:tenant", "platform:job", "platform:monitor"]));
      const tenantMenus = (await h.call(tenantAdminToken).get("/api/menus")).body as Array<{ code: string | null }>;
      expect(tenantMenus.some((m) => m.code?.startsWith("platform"))).toBe(false);
      expect((await h.call(tenantAdminToken).get("/api/roles/menu-tree")).body.map((n: { code: string }) => n.code)).not.toContain("platform");
    });

    it("a disabled platform account is refused at once; a pending one can only see itself", async () => {
      const u = await fx.user("p.tmp", { roles: ["platform-super"] });
      const token = await u.token();
      expect((await platformCall(h.app, token).get("/api/platform/tenants")).status).toBe(200);
      expect((await root().patch(`/api/platform/accounts/${u.accountId}/status`, { status: "disabled" })).status).toBe(200);
      expect((await platformCall(h.app, token).get("/api/platform/tenants")).status).toBe(403);
      const pending = await fx.user("p.pending", { roles: ["platform-super"], status: "pending" });
      const pToken = await pending.token();
      expect((await platformCall(h.app, pToken).get("/api/platform/me")).status).toBe(200);
      expect((await platformCall(h.app, pToken).get("/api/platform/tenants")).status).toBe(403);
      // 登录登记把待激活账号变成正常，之后立即可用
      expect((await platformCall(h.app, pToken).post("/api/platform/auth/session")).status).toBe(201);
      expect((await h.owner.platformAccount.findUniqueOrThrow({ where: { id: pending.accountId } })).status).toBe("active");
      expect((await platformCall(h.app, pToken).get("/api/platform/tenants")).status).toBe(200);
    });
  });

  describe("tenant management", () => {
    let code: string;
    let id: string;

    it("opens a tenant: realm, headquarters, roles, built-in administrator and an invitation e-mail", async () => {
      code = randomCode("pt");
      createdTenants.push(code);
      const res = await root().post("/api/platform/tenants", { code, name: "Platform Test", type: "franchise", adminEmail: `boss@${code}.example.test`, hqCampusName: "Test HQ" });
      expect(res.status).toBe(201);
      id = res.body.tenantId;
      expect(res.body.tenant).toMatchObject({ code, status: "active", type: "franchise", loginUrl: expect.stringContaining(code), admin: { email: `boss@${code}.example.test`, status: "pending" } });
      expect(await h.keycloak.realmExists(`tenant-${code}`)).toBe(true);
      expect(await h.owner.campus.findFirstOrThrow({ where: { tenantId: id } })).toMatchObject({ code: "HQ", name: "Test HQ" });
      expect(await mailTo(`boss@${code}.example.test`)).toBe(true);
      // 新租户默认授权全部租户侧功能，但没有平台入口的菜单
      const grants = (await root().get(`/api/platform/tenants/${id}/grants`)).body;
      expect(grants.granted.length).toBeGreaterThan(10);
      const all = JSON.stringify(grants.tree);
      expect(all).not.toContain("platform:tenant");
    });

    it("rejects a duplicate, a reserved or malformed code, and a bad e-mail; there is no delete", async () => {
      expect((await root().post("/api/platform/tenants", { code, name: "Dup", adminEmail: "a@example.test" })).status).toBe(409);
      expect((await root().post("/api/platform/tenants", { code: "admin", name: "Reserved", adminEmail: "a@example.test" })).status).toBe(400);
      expect((await root().post("/api/platform/tenants", { code: "Bad_Code", name: "Bad", adminEmail: "a@example.test" })).status).toBe(400);
      expect((await root().post("/api/platform/tenants", { code: randomCode("pt"), name: "Mail", adminEmail: "nope" })).status).toBe(400);
      expect((await root().del(`/api/platform/tenants/${id}`)).status).toBe(404);
    });

    it("edits basic information but never the tenant code", async () => {
      const ok = await root().patch(`/api/platform/tenants/${id}`, { name: "Platform Test 2", contactName: "Ada", contactPhone: "123", remark: "demo", timezone: "Asia/Shanghai" });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ name: "Platform Test 2", contactName: "Ada", remark: "demo", code });
      expect((await root().patch(`/api/platform/tenants/${id}`, { code: "changed" })).status).toBe(400);
      expect((await root().patch("/api/platform/tenants/11111111-1111-4111-8111-111111111111", { name: "x" })).status).toBe(404);
    });

    it("follows the status machine: notify (with an e-mail), suspend (login refused, data kept), restore", async () => {
      const tenantHost = `${code}.localhost`;
      expect((await root().post(`/api/platform/tenants/${id}/status`, { action: "restore" })).status).toBe(409); // 正常的租户不能"恢复"
      expect((await root().post(`/api/platform/tenants/${id}/status`, { action: "notify" })).status).toBe(400); // 需要通知内容
      const planned = new Date(Date.now() + 7 * 864e5).toISOString();
      const notified = await root().post(`/api/platform/tenants/${id}/status`, { action: "notify", noticeText: "Maintenance window", plannedSuspendAt: planned });
      expect(notified.status).toBe(201);
      expect(notified.body).toMatchObject({ status: "notified", noticeText: "Maintenance window", mailed: true });
      expect(await mailTo(`boss@${code}.example.test`, "Planned suspension")).toBe(true);
      expect((await h.call(null, tenantHost).get("/api/me")).status).toBe(401); // 已通知待停用：租户仍可用（只是还没令牌）

      expect((await root().post(`/api/platform/tenants/${id}/status`, { action: "suspend" })).body).toMatchObject({ status: "suspended" });
      expect((await h.call(null, tenantHost).get("/api/me")).status).toBe(403); // 已停用：被拒
      expect(await h.owner.campus.count({ where: { tenantId: id } })).toBe(1); // 数据保留
      expect((await root().post(`/api/platform/tenants/${id}/status`, { action: "notify", noticeText: "x" })).status).toBe(409);

      expect((await root().post(`/api/platform/tenants/${id}/status`, { action: "restore" })).body).toMatchObject({ status: "active", noticeText: null, plannedSuspendAt: null });
      expect((await h.call(null, tenantHost).get("/api/me")).status).toBe(401);
      // 通知可以撤销
      await root().post(`/api/platform/tenants/${id}/status`, { action: "notify", noticeText: "again" });
      expect((await root().post(`/api/platform/tenants/${id}/status`, { action: "cancel-notice" })).body.status).toBe("active");
    });

    it("function grants: closing a directory removes it from the tenant's menus and permissions at once; platform menus cannot be granted", async () => {
      const grants = (await root().get(`/api/platform/tenants/${id}/grants`)).body as { granted: string[]; tree: { admin: Array<{ id: string; code: string; children: unknown[] }> } };
      const hr = grants.tree.admin.find((n) => n.code === "hr")!;
      const descendants = (n: { id: string; children?: unknown[] }): string[] => [n.id, ...((n.children ?? []) as Array<{ id: string; children?: unknown[] }>).flatMap(descendants)];
      const hrIds = new Set(descendants(hr));
      const without = grants.granted.filter((g) => !hrIds.has(g));
      expect((await root().put(`/api/platform/tenants/${id}/grants`, { menuIds: without })).status).toBe(200);
      // 通过接口开通的租户没有打开密码直连（只有测试需要），这里给它的门户客户端打开
      const portal = (await (await h.keycloak.request(`/realms/tenant-${code}/clients?clientId=portal`)).json()) as Array<Record<string, unknown> & { id: string }>;
      await h.keycloak.request(`/realms/tenant-${code}/clients/${portal[0].id}`, { method: "PUT", body: JSON.stringify({ ...portal[0], directAccessGrantsEnabled: true }) });
      const tenantUserToken = await (await h.user("grant.user", { tenant: { tenantId: id, code } as never, roles: ["tenant-admin"], person: "staff" })).token();
      const menus = (await h.call(tenantUserToken, `${code}.localhost`).get("/api/me/menus?entry=admin")).body as Array<{ code: string }>;
      expect(menus.map((m) => m.code)).toEqual(["edu", "system"]);
      expect((await h.call(tenantUserToken, `${code}.localhost`).get("/api/persons")).status).toBe(403);
      // 平台入口的菜单不能授权给租户
      const platformMenu = await h.owner.menu.findFirstOrThrow({ where: { tenantId: null, code: "platform:tenant" } });
      expect((await root().put(`/api/platform/tenants/${id}/grants`, { menuIds: [...without, platformMenu.id] })).status).toBe(400);
      expect((await root().put(`/api/platform/tenants/${id}/grants`, { menuIds: grants.granted })).status).toBe(200); // 恢复
      expect((await h.call(tenantUserToken, `${code}.localhost`).get("/api/persons")).status).toBe(200);
    });

    it("administrator tab: shows the built-in administrator, resends the invitation, sends a reset link, unlocks, changes the e-mail", async () => {
      const a = await root().get(`/api/platform/tenants/${id}/admin`);
      expect(a.body).toMatchObject({ username: "admin", status: "pending", keycloakEnabled: true });
      expect((await root().post(`/api/platform/tenants/${id}/admin/invite`)).body).toEqual({ sent: true });
      expect((await root().post(`/api/platform/tenants/${id}/admin/reset-password`)).body).toEqual({ sent: true });
      expect((await root().post(`/api/platform/tenants/${id}/admin/unlock`)).body).toEqual({ unlocked: true });
      const changed = await root().patch(`/api/platform/tenants/${id}/admin/email`, { email: `new@${code}.example.test` });
      expect(changed.body.email).toBe(`new@${code}.example.test`);
      expect((await h.keycloak.findUser(`tenant-${code}`, "admin")) !== null).toBe(true);
      expect((await root().patch(`/api/platform/tenants/${id}/admin/email`, { email: "bad" })).status).toBe(400);
    });

    it("lists tenants with their status and administrator", async () => {
      const list = (await root().get("/api/platform/tenants")).body as Array<{ code: string; status: string; admin: { email: string } | null }>;
      expect(list.find((t) => t.code === code)).toMatchObject({ status: "active", admin: { email: `new@${code}.example.test` } });
      expect(list.find((t) => t.code === h.tenant.code)).toBeDefined();
    });
  });

  describe("platform accounts and roles (same RBAC machinery, separate world)", () => {
    it("a limited platform role sees only what it was given; the built-in super role and account cannot be changed", async () => {
      const role = (await root().post("/api/platform/roles", { code: "viewer-x", name: "Viewer" })).body;
      fx.trackRole(role.id);
      const tree = (await root().get("/api/platform/roles/menu-tree")).body as Array<{ id: string; code: string; children: Array<{ id: string; code: string }> }>;
      const tenantMenu = tree[0].children.find((c) => c.code === "platform:tenant")!;
      expect((await root().put(`/api/platform/roles/${role.id}/menus`, { menuIds: [tree[0].id, tenantMenu.id] })).status).toBe(200);
      const viewer = await fx.user("p.viewer", { roles: ["viewer-x"] });
      const vt = await viewer.token();
      expect((await platformCall(h.app, vt).get("/api/platform/tenants")).status).toBe(200);
      expect((await platformCall(h.app, vt).post("/api/platform/tenants", { code: randomCode("pt"), name: "x", adminEmail: "a@example.test" })).status).toBe(403);
      expect((await platformCall(h.app, vt).get("/api/platform/jobs")).status).toBe(403);
      expect((await platformCall(h.app, vt).get("/api/platform/me/menus")).body[0].children.map((c: { code: string }) => c.code)).toEqual(["platform:tenant"]);

      const superRole = (await root().get("/api/platform/roles")).body.find((r: { kind: string }) => r.kind === "super");
      expect((await root().del(`/api/platform/roles/${superRole.id}`)).status).toBe(403);
      expect((await root().put(`/api/platform/roles/${superRole.id}/menus`, { menuIds: [] })).status).toBe(403);
      const other = await fx.user("p.other");
      expect((await root().put(`/api/platform/accounts/${other.accountId}/roles`, { roleIds: [superRole.id] })).status).toBe(403); // 内置角色不能手动分配
    });

    it("someone who can edit roles cannot grant platform permissions they do not hold", async () => {
      const editorRole = (await root().post("/api/platform/roles", { code: "editor-x", name: "Editor" })).body;
      fx.trackRole(editorRole.id);
      const tree = (await root().get("/api/platform/roles/menu-tree")).body as Array<{ id: string; children: Array<{ id: string; code: string; children: Array<{ id: string; code: string }> }> }>;
      const find = (code: string) => tree[0].children.flatMap((c) => [c, ...c.children]).find((c) => c.code === code)!.id;
      expect(
        (await root().put(`/api/platform/roles/${editorRole.id}/menus`, { menuIds: [tree[0].id, find("platform:role"), find("platform:role:authorize"), find("platform:role:add")] })).status,
      ).toBe(200);
      const editor = await fx.user("p.editor", { roles: ["editor-x"] });
      const et = platformCall(h.app, await editor.token());
      const target = (await et.post("/api/platform/roles", { code: "target-x", name: "Target" })).body;
      fx.trackRole(target.id);
      expect((await et.put(`/api/platform/roles/${target.id}/menus`, { menuIds: [find("platform:role")] })).status).toBe(200);
      expect((await et.put(`/api/platform/roles/${target.id}/menus`, { menuIds: [find("platform:tenant")] })).status).toBe(403);
    });

    it("creates an account with an invitation, and refuses duplicates", async () => {
      const res = await root().post("/api/platform/accounts", { username: "p.newhire", email: "p.newhire@platform.example.test" });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: "pending", inviteSent: true });
      expect(await mailTo("p.newhire@platform.example.test")).toBe(true);
      const row = await h.owner.platformAccount.findUniqueOrThrow({ where: { id: res.body.id } });
      if (row.keycloakUserId) await h.keycloak.request(`/realms/platform/users/${row.keycloakUserId}`, { method: "DELETE" });
      await h.owner.platformAccount.delete({ where: { id: row.id } });
      expect((await root().post("/api/platform/accounts", { username: "p.root", email: "x@example.test" })).status).toBe(409);
    });
  });

  describe("menus and entries", () => {
    it("platform may hide a menu or change its order; the entry assignment accepts only top-level platform menus", async () => {
      const menus = (await root().get("/api/platform/menus")).body as Array<{ id: string; code: string; visible: boolean; entries: string[] }>;
      const online = menus.find((m) => m.code === "system:online")!;
      expect(online.entries).toEqual(["admin"]);
      expect((await root().patch(`/api/platform/menus/${online.id}`, { visible: false })).status).toBe(200);
      try {
        // 租户看不到隐藏的菜单
        expect(JSON.stringify((await h.call(tenantAdminToken).get("/api/me/menus?entry=admin")).body)).not.toContain("system:online");
      } finally {
        await root().patch(`/api/platform/menus/${online.id}`, { visible: true });
      }
      expect((await root().patch(`/api/platform/menus/${online.id}`, { name: "x" })).status).toBe(400); // 只能改显示、启用、排序
      const child = menus.find((m) => m.code === "system:role")!;
      expect((await root().put("/api/platform/entries/admin/menus", { menus: [{ menuId: child.id, sort: 1 }] })).status).toBe(400); // 不是顶层
      expect((await root().put("/api/platform/entries/nope/menus", { menus: [] })).status).toBe(404);
      const entries = (await root().get("/api/platform/entries")).body as Array<{ code: string; menus: unknown[] }>;
      expect(entries.map((e) => e.code).sort()).toEqual(["admin", "platform", "portal"]);
    });
  });

  describe("scheduled jobs", () => {
    it("only registered jobs exist; arbitrary names are refused; cron must be a valid 5-field expression", async () => {
      const jobs = (await root().get("/api/platform/jobs")).body as Array<{ code: string; cron: string; enabled: boolean }>;
      expect(jobs.map((j) => j.code).sort()).toEqual(["accounts.reconcile", "logs.purge-params", "staff.apply-effective", "tenants.suspend-due"]);
      expect((await root().patch("/api/platform/jobs/rm -rf /", { enabled: true })).status).toBe(404);
      expect((await root().post("/api/platform/jobs/not.a.job/run")).status).toBe(404);
      expect((await root().patch("/api/platform/jobs/tenants.suspend-due", { cron: "every day" })).status).toBe(409);
      expect((await root().patch("/api/platform/jobs/tenants.suspend-due", { cron: "* * * * * *" })).status).toBe(409); // 带秒的写法
      expect((await root().patch("/api/platform/jobs/tenants.suspend-due", { cron: "61 * * * *" })).status).toBe(409);
      expect((await root().patch("/api/platform/jobs/tenants.suspend-due", { command: "x" })).status).toBe(400);
      const ok = await root().patch("/api/platform/jobs/tenants.suspend-due", { cron: "*/15 * * * *" });
      expect(ok.status).toBe(200);
      expect(ok.body.cron).toBe("*/15 * * * *");
      await root().patch("/api/platform/jobs/tenants.suspend-due", { cron: "*/10 * * * *" });
    });

    it("runs now, writes a run log, and suspends a tenant whose planned time has passed", async () => {
      const due = randomCode("pt");
      createdTenants.push(due);
      const created = await root().post("/api/platform/tenants", { code: due, name: "Due", adminEmail: `a@${due}.example.test` });
      await h.owner.tenant.update({ where: { id: created.body.tenantId }, data: { status: "notified", plannedSuspendAt: new Date(Date.now() - 60_000), noticeText: "due" } });
      const run = await root().post("/api/platform/jobs/tenants.suspend-due/run");
      expect(run.status).toBe(201);
      expect(run.body).toMatchObject({ status: "success" });
      expect((await h.owner.tenant.findUniqueOrThrow({ where: { id: created.body.tenantId } })).status).toBe("suspended");
      const runs = (await root().get("/api/platform/jobs/tenants.suspend-due/runs")).body as Array<{ trigger: string; status: string; message: string }>;
      expect(runs[0]).toMatchObject({ trigger: "manual", status: "success" });
      expect(runs[0].message).toMatch(/suspended/);
      const job = (await root().get("/api/platform/jobs")).body.find((j: { code: string }) => j.code === "tenants.suspend-due");
      expect(job.lastStatus).toBe("success");
    });

    it("a job that is already running is not started twice", async () => {
      await h.redis.set("job:lock:tenants.suspend-due", "1", "EX", 30);
      try {
        expect((await root().post("/api/platform/jobs/tenants.suspend-due/run")).status).toBe(409);
      } finally {
        await h.redis.del("job:lock:tenants.suspend-due");
      }
    });
  });

  describe("monitoring and external links", () => {
    it("reports server, cache and database health", async () => {
      const m = (await root().get("/api/platform/monitor")).body;
      expect(m.server).toMatchObject({ nodeVersion: process.version, cpuCount: expect.any(Number) });
      expect(m.server.totalMemoryBytes).toBeGreaterThan(m.server.freeMemoryBytes);
      expect(m.cache).toMatchObject({ ok: true, version: expect.any(String) });
      expect(m.cache.usedMemoryBytes).toBeGreaterThan(0);
      expect(m.database.ok).toBe(true);
    });

    it("says Grafana is not configured / not running, and where Swagger is", async () => {
      const l = (await root().get("/api/platform/external-links")).body;
      expect(l.grafana).toMatchObject({ up: false });
      expect(l.swagger.enabled).toBe(true);
      expect(l.swagger.path).toBe("/api-docs");
    });
  });

  it("platform actions are written to the platform audit log", async () => {
    const logs = (await root().get("/api/platform/audit-logs?size=100")).body as Array<{ action: string }>;
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(["tenant.create", "tenant.update", "tenant.notify", "tenant.suspend", "tenant.restore", "tenant.grants", "tenant.admin.invite", "job.run"]));
    expect(PLATFORM_HOST).toBe("platform.localhost");
  });
});
