// 角色模板升级：模板后来新增的菜单，已复制给公司的角色不会自动更新；管理员可以预览差异，一键只补缺的（不删公司自己调过的）。
import { Harness } from "../helpers/app";

describe("role template upgrade", () => {
  const h = new Harness();
  let bossToken: string;
  let daveToken: string;
  let teacherRole: string;
  const admin = () => h.call(bossToken);
  const NEW = ["edu:request", "edu:request:decide", "edu:section:grade"];
  const menuId = async (code: string) => (await h.owner.menu.findFirstOrThrow({ where: { tenantId: null, code } })).id;

  beforeAll(async () => {
    await h.start();
    bossToken = await (await h.user("boss", { roles: ["tenant-admin"], person: "staff" })).token();
    const dave = await h.user("dave", { person: "staff" });
    daveToken = await dave.token();
    teacherRole = (await h.owner.role.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, code: "teacher" } })).id;
    // 模拟"老版本复制的副本"：缺三个后来新增的菜单，另外有公司自己多勾的一个
    await h.owner.roleMenu.deleteMany({ where: { roleId: teacherRole, menuId: { in: await Promise.all(NEW.map(menuId)) } } });
    await h.owner.roleMenu.create({ data: { tenantId: h.tenant.tenantId, roleId: teacherRole, menuId: await menuId("hr:student") } });
    await h.bump(h.tenant.tenantId);
    // dave：能看和改角色权限，但自己没有"学生申请"的权限
    const rolemgr = (await admin().post("/api/roles", { code: "rolemgr", name: "Role manager" })).body.id as string;
    const ids = await Promise.all(["system", "system:role", "system:role:authorize"].map(menuId));
    expect((await admin().put(`/api/roles/${rolemgr}/menus`, { menuIds: ids })).status).toBe(200);
    expect((await admin().put(`/api/accounts/${dave.accountId}/roles`, { roleIds: [rolemgr] })).status).toBe(200);
  });
  afterAll(() => h.stop());

  it("the role list shows how many template menus each copy is missing", async () => {
    const roles = (await admin().get("/api/roles")).body as Array<{ code: string; templateMissingCount: number }>;
    expect(roles.find((r) => r.code === "teacher")?.templateMissingCount).toBe(3);
    expect(roles.find((r) => r.code === "academic-manager")?.templateMissingCount).toBe(0);
    expect(roles.find((r) => r.code === "tenant-admin")?.templateMissingCount).toBe(0);
  });

  it("the preview lists exactly the missing menus and changes nothing", async () => {
    const res = await admin().get(`/api/roles/${teacherRole}/template-diff`);
    expect(res.status).toBe(200);
    expect(res.body.template).toMatchObject({ code: "teacher" });
    expect(res.body.missing.map((m: { code: string }) => m.code).sort()).toEqual([...NEW].sort());
    expect(await h.owner.roleMenu.count({ where: { roleId: teacherRole, menuId: await menuId("edu:request") } })).toBe(0);
  });

  it("a menu the company has not been granted is not offered", async () => {
    const id = await menuId("edu:request:decide");
    const grant = await h.owner.tenantMenuGrant.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, menuId: id } });
    await h.owner.tenantMenuGrant.delete({ where: { id: grant.id } });
    await h.bump(h.tenant.tenantId);
    expect((await admin().get(`/api/roles/${teacherRole}/template-diff`)).body.missing.map((m: { code: string }) => m.code)).not.toContain("edu:request:decide");
    await h.owner.tenantMenuGrant.create({ data: { tenantId: h.tenant.tenantId, menuId: id } });
    await h.bump(h.tenant.tenantId);
  });

  it("built-in roles and roles without a template have no diff", async () => {
    const builtin = await h.owner.role.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, code: "tenant-admin" } });
    expect((await admin().get(`/api/roles/${builtin.id}/template-diff`)).status).toBe(404);
    const custom = (await admin().post("/api/roles", { code: "mine", name: "Mine" })).body.id as string;
    expect((await admin().get(`/api/roles/${custom}/template-diff`)).status).toBe(404);
    expect((await admin().post(`/api/roles/${custom}/template-upgrade`)).status).toBe(404);
    expect((await admin().post(`/api/roles/${builtin.id}/template-upgrade`)).status).toBe(403);
  });

  it("nobody can hand out permissions they do not hold", async () => {
    expect((await h.call(daveToken).get(`/api/roles/${teacherRole}/template-diff`)).status).toBe(200);
    expect((await h.call(daveToken).post(`/api/roles/${teacherRole}/template-upgrade`)).status).toBe(403);
    expect(await h.owner.roleMenu.count({ where: { roleId: teacherRole, menuId: await menuId("edu:request") } })).toBe(0);
  });

  it("applying adds only what is missing, keeps the company's own ticks, audits it, and is repeatable", async () => {
    const before = (await h.owner.roleMenu.findMany({ where: { roleId: teacherRole } })).map((m) => m.menuId);
    const res = await admin().post(`/api/roles/${teacherRole}/template-upgrade`);
    expect(res.status).toBe(201);
    expect([...res.body.added].sort()).toEqual([...NEW].sort());
    const after = (await h.owner.roleMenu.findMany({ where: { roleId: teacherRole } })).map((m) => m.menuId);
    expect(after.length).toBe(before.length + 3);
    expect(before.every((m) => after.includes(m))).toBe(true); // 原有的（包括公司多勾的 hr:student）一个都没少
    expect(after).toContain(await menuId("hr:student"));
    expect((await admin().post(`/api/roles/${teacherRole}/template-upgrade`)).body.added).toEqual([]);
    expect((await admin().get(`/api/roles/${teacherRole}/template-diff`)).body.missing).toEqual([]);
    expect(await h.owner.auditLog.count({ where: { tenantId: h.tenant.tenantId, action: "role.templateUpgrade", targetId: teacherRole } })).toBe(1);
  });

  it("the new menus take effect for the people holding the role at once", async () => {
    const teacher = await h.user("teacher.t", { roles: ["teacher"], person: "staff" });
    const me = (await h.call(await teacher.token()).get("/api/me")).body;
    expect(me.permissions).toEqual(expect.arrayContaining(["edu:request:list", "edu:request:decide"]));
  });
});
