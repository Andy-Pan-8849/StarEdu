// RBAC：角色与权限字符、权限版本号、内置角色、防提权、菜单与入口、功能授权、操作日志。
import { Harness } from "../helpers/app";

describe("RBAC", () => {
  const h = new Harness();
  let boss: Awaited<ReturnType<Harness["user"]>>;
  let bossToken: string;
  let menuIds: Record<string, string>;
  const admin = () => h.call(bossToken);

  beforeAll(async () => {
    await h.start();
    boss = await h.user("boss", { roles: ["tenant-admin"], person: "staff" });
    bossToken = await boss.token();
    const menus = (await admin().get("/api/menus")).body as Array<{ id: string; code: string | null }>;
    menuIds = Object.fromEntries(menus.filter((m) => m.code).map((m) => [m.code as string, m.id]));
  });
  afterAll(() => h.stop());

  const ids = (...codes: string[]) => codes.map((c) => menuIds[c]);

  it("the built-in tenant administrator holds every operation permission of the enabled admin features (no wildcard)", async () => {
    const me = (await admin().get("/api/me")).body;
    expect(me.permissions).toEqual(expect.arrayContaining(["system:role:add", "system:menu:remove", "system:online:forceLogout", "hr:person:edit"]));
    expect(me.permissions.every((p: string) => /^[a-z]\w*:[a-z]\w*:[a-z]\w*$/.test(p))).toBe(true); // 都是具体的权限字符
    expect(me.permissions).not.toContain("*:*:*");
    expect(me.roles.map((r: { kind: string }) => r.kind)).toEqual(["tenant_admin"]);
  });

  describe("custom roles and the permission version", () => {
    let roleId: string;
    let dave: Awaited<ReturnType<Harness["user"]>>;
    let daveToken: string;

    it("a role with no permissions grants nothing", async () => {
      const created = await admin().post("/api/roles", { code: "auditor", name: "Auditor" });
      expect(created.status).toBe(201);
      roleId = created.body.id;
      dave = await h.user("dave", { person: "staff" });
      daveToken = await dave.token();
      expect((await h.call(daveToken).get("/api/roles")).status).toBe(403);
      expect((await h.call(daveToken).get("/api/me")).status).toBe(200); // 任何已登录账号都能看自己
    });

    it("assigning a role and ticking menus takes effect on the next request; removing them takes it away again", async () => {
      expect((await admin().put(`/api/roles/${roleId}/menus`, { menuIds: ids("system", "system:role") })).status).toBe(200);
      expect((await admin().put(`/api/accounts/${dave.accountId}/roles`, { roleIds: [roleId] })).status).toBe(200);
      expect((await h.call(daveToken).get("/api/roles")).status).toBe(200); // 下一个请求就生效
      expect((await h.call(daveToken).post("/api/roles", { code: "x-role", name: "X" })).status).toBe(403); // 没勾"新增"按钮

      expect((await admin().put(`/api/roles/${roleId}/menus`, { menuIds: ids("system", "system:role", "system:role:add") })).status).toBe(200);
      expect((await h.call(daveToken).post("/api/roles", { code: "x-role", name: "X" })).status).toBe(201);

      expect((await admin().put(`/api/roles/${roleId}/menus`, { menuIds: [] })).status).toBe(200);
      expect((await h.call(daveToken).get("/api/roles")).status).toBe(403);
    });

    it("a feature switched off for the tenant (function grant) disappears from permissions at once", async () => {
      expect((await admin().put(`/api/roles/${roleId}/menus`, { menuIds: ids("hr", "hr:person") })).status).toBe(200);
      expect((await h.call(daveToken).get("/api/persons")).status).toBe(200);
      const hr = await h.owner.menu.findFirstOrThrow({ where: { tenantId: null, code: "hr" } });
      await h.owner.tenantMenuGrant.deleteMany({ where: { tenantId: h.tenant.tenantId, menuId: hr.id } });
      await h.bump();
      try {
        expect((await h.call(daveToken).get("/api/persons")).status).toBe(403);
        expect((await admin().get("/api/persons")).status).toBe(403); // 租户管理员也一样
        const tree = (await admin().get("/api/roles/menu-tree")).body as Array<{ code: string }>;
        expect(tree.map((n) => n.code)).toEqual(["system"]); // 角色勾选树里没有了
        expect((await admin().put(`/api/roles/${roleId}/menus`, { menuIds: ids("hr") })).status).toBe(400); // 也不能再勾
        expect((await admin().get("/api/me/menus?entry=admin")).body.map((n: { code: string }) => n.code)).toEqual(["system"]);
      } finally {
        await h.owner.tenantMenuGrant.create({ data: { tenantId: h.tenant.tenantId, menuId: hr.id } });
        await h.bump();
      }
      expect((await admin().get("/api/persons")).status).toBe(200);
    });

    it("a role cannot be deleted while assigned; after deletion its code can be reused", async () => {
      expect((await admin().del(`/api/roles/${roleId}`)).status).toBe(409);
      expect((await admin().put(`/api/accounts/${dave.accountId}/roles`, { roleIds: [] })).status).toBe(200);
      expect((await admin().del(`/api/roles/${roleId}`)).status).toBe(200);
      expect((await admin().get(`/api/roles/${roleId}`)).status).toBe(404);
      expect((await admin().post("/api/roles", { code: "auditor", name: "Auditor again" })).status).toBe(201);
      expect((await admin().post("/api/roles", { code: "auditor", name: "Duplicate" })).status).toBe(409);
      expect((await admin().post("/api/roles", { code: "Bad Code", name: "x" })).status).toBe(400);
    });
  });

  describe("built-in roles", () => {
    it("the tenant administrator and student roles cannot be changed, deleted or reassigned", async () => {
      const roles = (await admin().get("/api/roles")).body as Array<{ id: string; kind: string; code: string }>;
      const tenantAdmin = roles.find((r) => r.kind === "tenant_admin")!;
      const student = roles.find((r) => r.kind === "student")!;
      for (const role of [tenantAdmin, student]) {
        expect((await admin().patch(`/api/roles/${role.id}`, { name: "renamed" })).status).toBe(403);
        expect((await admin().del(`/api/roles/${role.id}`)).status).toBe(403);
        expect((await admin().put(`/api/roles/${role.id}/menus`, { menuIds: [] })).status).toBe(403);
        expect((await admin().put(`/api/roles/${role.id}/data-scopes`, { setIds: [] })).status).toBe(403);
      }
      const bob = await h.user("bob", { person: "staff" });
      expect((await admin().put(`/api/accounts/${bob.accountId}/roles`, { roleIds: [student.id] })).status).toBe(403);
      expect((await admin().put(`/api/accounts/${bob.accountId}/roles`, { roleIds: [tenantAdmin.id] })).status).toBe(403);
    });

    it("the built-in administrator's roles cannot be changed", async () => {
      const builtin = await h.owner.account.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, isBuiltinAdmin: true } });
      expect((await admin().put(`/api/accounts/${builtin.id}/roles`, { roleIds: [] })).status).toBe(403);
    });

    it("creating a student account assigns the built-in student role automatically", async () => {
      const res = await admin().post("/api/accounts", { username: "stu.one", email: "stu.one@example.test", kind: "student" });
      expect(res.status).toBe(201);
      expect(res.body.keycloakUserId).toBeTruthy();
      expect(res.body.inviteSent).toBe(true);
      const account = (await admin().get(`/api/accounts/${res.body.id}`)).body;
      const student = (await h.owner.role.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, kind: "student" } })).id;
      expect(account.roleIds).toEqual([student]);
      // 分配自定义角色时，学生角色保持不变
      const custom = (await admin().post("/api/roles", { code: "club-lead", name: "Club lead" })).body.id;
      expect((await admin().put(`/api/accounts/${res.body.id}/roles`, { roleIds: [custom] })).status).toBe(200);
      expect((await admin().get(`/api/accounts/${res.body.id}`)).body.roleIds.sort()).toEqual([custom, student].sort());
    });
  });

  describe("privilege escalation", () => {
    it("someone who can edit roles cannot grant permissions they do not hold themselves", async () => {
      const editor = await h.user("editor", { person: "staff" });
      const editorToken = await editor.token();
      const mid = (await admin().post("/api/roles", { code: "role-editor", name: "Role editor" })).body.id;
      const target = (await admin().post("/api/roles", { code: "target-role", name: "Target" })).body.id;
      expect(
        (await admin().put(`/api/roles/${mid}/menus`, { menuIds: ids("system", "system:role", "system:role:authorize", "system:user", "system:user:assignRole") })).status,
      ).toBe(200);
      expect((await admin().put(`/api/accounts/${editor.accountId}/roles`, { roleIds: [mid] })).status).toBe(200);

      // 可以授予自己拥有的
      expect((await h.call(editorToken).put(`/api/roles/${target}/menus`, { menuIds: ids("system", "system:role", "system:user") })).status).toBe(200);
      // 不能授予自己没有的：hr:person:edit、以及"菜单管理"的 system:menu:list
      expect((await h.call(editorToken).put(`/api/roles/${target}/menus`, { menuIds: ids("hr", "hr:person", "hr:person:edit") })).status).toBe(403);
      expect((await h.call(editorToken).put(`/api/roles/${target}/menus`, { menuIds: ids("system", "system:menu") })).status).toBe(403);
      // 也不能把权限比自己大的角色分配给别人
      const other = await h.user("other", { person: "staff" });
      const strong = (await admin().post("/api/roles", { code: "strong-role", name: "Strong" })).body.id;
      expect((await admin().put(`/api/roles/${strong}/menus`, { menuIds: ids("hr", "hr:person", "hr:person:edit") })).status).toBe(200);
      expect((await h.call(editorToken).put(`/api/accounts/${other.accountId}/roles`, { roleIds: [strong] })).status).toBe(403);
      expect((await h.call(editorToken).put(`/api/accounts/${other.accountId}/roles`, { roleIds: [target] })).status).toBe(200);
    });
  });

  describe("menus and entries", () => {
    it("platform-provided menus are read-only for the tenant", async () => {
      const id = menuIds["system:role"];
      expect((await admin().patch(`/api/menus/${id}`, { name: "hacked" })).status).toBe(403);
      expect((await admin().del(`/api/menus/${id}`)).status).toBe(403);
      const list = (await admin().get("/api/menus")).body as Array<{ code: string; platformProvided: boolean; entries: string[] }>;
      expect(list.find((m) => m.code === "system:role")).toMatchObject({ platformProvided: true, entries: ["admin"] }); // 子级跟随顶层的入口
    });

    it("a tenant may only add directories and external links; buttons and menus with permissions are refused", async () => {
      expect((await admin().post("/api/menus", { name: "Btn", type: "button" })).status).toBe(400);
      expect((await admin().post("/api/menus", { name: "Menu", type: "menu" })).status).toBe(400);
      expect((await admin().post("/api/menus", { name: "Dir", type: "directory", perms: "system:role:add" })).status).toBe(400); // 不能带权限标识
      expect((await admin().post("/api/menus", { name: "Link", type: "link", route: "javascript:alert(1)" })).status).toBe(400);
      expect((await admin().post("/api/menus", { name: "Link", type: "link" })).status).toBe(400);
      // 不能挂在按钮下，也不能挂在不存在的上级下
      expect((await admin().post("/api/menus", { name: "Under button", type: "directory", parentId: menuIds["system:role:add"] })).status).toBe(400);
      expect((await admin().post("/api/menus", { name: "Orphan", type: "directory", parentId: "11111111-1111-4111-8111-111111111111" })).status).toBe(400);
    });

    it("a tenant-built menu starts unassigned, can be assigned to an entry, and shows up for roles that tick it", async () => {
      const dir = (await admin().post("/api/menus", { name: "Partner tools", type: "directory", icon: "tool" })).body;
      const link = (await admin().post("/api/menus", { name: "Partner wiki", type: "link", route: "https://wiki.example.test", parentId: dir.id })).body;
      const before = (await admin().get("/api/entries")).body;
      expect(before.unassigned.map((m: { menuId: string }) => m.menuId)).toContain(dir.id); // 草稿：不显示在任何入口
      expect((await admin().get("/api/me/menus?entry=admin")).body.map((n: { name: string }) => n.name)).not.toContain("Partner tools");

      // 租户管理员 = 管理后台入口下全部生效的菜单；分配之后出现
      expect((await admin().put("/api/entries/admin/menus", { menus: [{ menuId: dir.id, sort: 5 }] })).status).toBe(200);
      const tree = (await admin().get("/api/me/menus?entry=admin")).body as Array<{ name: string; children: Array<{ name: string; route: string }> }>;
      const partner = tree.find((n) => n.name === "Partner tools");
      expect(partner?.children).toEqual([expect.objectContaining({ name: "Partner wiki", route: "https://wiki.example.test" })]);
      const afterAssign = (await admin().get("/api/entries")).body;
      expect(afterAssign.unassigned.map((m: { menuId: string }) => m.menuId)).not.toContain(dir.id);
      expect(afterAssign.entries.find((e: { code: string }) => e.code === "admin").menus.map((m: { menuId: string }) => m.menuId)).toContain(dir.id);

      // 只有勾选了的角色才能看到：新角色勾了目录和外链
      const role = (await admin().post("/api/roles", { code: "partner-role", name: "Partner" })).body.id;
      expect((await admin().put(`/api/roles/${role}/menus`, { menuIds: [dir.id, link.id] })).status).toBe(200);
      const viewer = await h.user("viewer", { roles: ["partner-role"], person: "staff" });
      const viewerTree = (await h.call(await viewer.token()).get("/api/me/menus?entry=admin")).body as Array<{ name: string }>;
      expect(viewerTree.map((n) => n.name)).toEqual(["Partner tools"]);

      // 平台的分配租户只读；门户入口也可以分配；平台入口不对租户开放
      expect((await admin().put("/api/entries/admin/menus", { menus: [{ menuId: menuIds.system, sort: 1 }] })).status).toBe(403);
      expect((await admin().put("/api/entries/portal/menus", { menus: [{ menuId: dir.id, sort: 1 }] })).status).toBe(200);
      expect((await admin().put("/api/entries/platform/menus", { menus: [] })).status).toBe(404);
      expect((await admin().put("/api/entries/admin/menus", { menus: [{ menuId: link.id, sort: 1 }] })).status).toBe(400); // 只能分配顶层
      expect((await admin().get("/api/entries")).body.entries.map((e: { code: string }) => e.code).sort()).toEqual(["admin", "portal"]);

      // 删除：有子菜单不让删；删除后勾选和入口分配一起清掉
      expect((await admin().del(`/api/menus/${dir.id}`)).status).toBe(409);
      expect((await admin().del(`/api/menus/${link.id}`)).status).toBe(200);
      expect((await admin().del(`/api/menus/${dir.id}`)).status).toBe(200);
      expect((await admin().get("/api/me/menus?entry=admin")).body.map((n: { name: string }) => n.name)).not.toContain("Partner tools");
      expect((await h.owner.roleMenu.count({ where: { roleId: role } }))).toBe(0);
    });

    it("hidden changes: editing a tenant-built menu works, an unknown menu id is a 404", async () => {
      const dir = (await admin().post("/api/menus", { name: "Temp", type: "directory" })).body;
      const res = await admin().patch(`/api/menus/${dir.id}`, { name: "Renamed", sort: 3 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: "Renamed", sort: 3 });
      expect((await admin().patch(`/api/menus/${dir.id}`, { perms: "system:role:add" })).status).toBe(400); // 不允许改权限标识
      expect((await admin().patch("/api/menus/11111111-1111-4111-8111-111111111111", { name: "x" })).status).toBe(404);
      await admin().del(`/api/menus/${dir.id}`);
    });
  });

  describe("data scope sets", () => {
    it("lists the five built-in sets; built-in sets are read-only; custom sets are validated and protected while in use", async () => {
      const list = (await admin().get("/api/data-scope-sets")).body as Array<{ id: string; code: string; kind: string; platformProvided: boolean }>;
      expect(list.filter((s) => s.platformProvided).map((s) => s.kind).sort()).toEqual(["all", "own_classes", "own_dept", "own_dept_tree", "self"]);
      const builtin = list.find((s) => s.code === "all")!;
      expect((await admin().put(`/api/data-scope-sets/${builtin.id}`, { name: "x", nodes: [{ deptId: "11111111-1111-4111-8111-111111111111" }] })).status).toBe(403);
      expect((await admin().del(`/api/data-scope-sets/${builtin.id}`)).status).toBe(403);

      const campus = (await admin().get("/api/depts")).body[0];
      expect((await admin().post("/api/data-scope-sets", { name: "No nodes", nodes: [] })).status).toBe(400);
      const created = await admin().post("/api/data-scope-sets", { name: "Whole HQ", nodes: [{ deptId: campus.id, includeChildren: true }] });
      expect(created.status).toBe(201);
      const role = (await admin().post("/api/roles", { code: "scoped", name: "Scoped" })).body.id;
      expect((await admin().put(`/api/roles/${role}/data-scopes`, { setIds: [created.body.id, builtin.id] })).status).toBe(200);
      expect((await admin().get(`/api/roles/${role}`)).body.dataScopeSetIds.sort()).toEqual([created.body.id, builtin.id].sort());
      expect((await admin().del(`/api/data-scope-sets/${created.body.id}`)).status).toBe(409); // 还有角色在用
      await admin().put(`/api/roles/${role}/data-scopes`, { setIds: [] });
      expect((await admin().del(`/api/data-scope-sets/${created.body.id}`)).status).toBe(200);
    });
  });

  it("permission and role changes are written to the audit log with what changed", async () => {
    const role = (await admin().post("/api/roles", { code: "logged", name: "Logged" })).body.id;
    await admin().put(`/api/roles/${role}/menus`, { menuIds: ids("system", "system:menu") });
    await admin().put(`/api/roles/${role}/menus`, { menuIds: ids("system", "system:entry") });
    const bob = await h.user("log.bob", { person: "staff" });
    await admin().put(`/api/accounts/${bob.accountId}/roles`, { roleIds: [role] });
    const logs = (await admin().get("/api/audit-logs?size=100")).body as Array<{ action: string; targetId: string; actorAccountId: string; detail: Record<string, string[]> }>;
    const forRole = logs.filter((l) => l.targetId === role);
    expect(forRole.map((l) => l.action).sort()).toEqual(["role.create", "role.menus", "role.menus"]);
    const second = forRole.filter((l) => l.action === "role.menus").find((l) => l.detail.removed.includes("system:menu"));
    expect(second?.detail.added).toEqual(["system:entry"]);
    expect(second?.actorAccountId).toBe(boss.accountId);
    expect(logs.find((l) => l.action === "account.roles" && l.targetId === bob.accountId)?.detail).toEqual({ before: [], after: [role] });
  });
});
