// 数据范围：账号 × 数据权限集矩阵，读写各一次；多角色并集；无关角色的"全部"不放大别的接口（S1）；
// 无适用集 = 看不到；多部门并集；改了之后下一个请求就生效；内置租户管理员只管教职员工；学生/班级维度。
import { DataScopeService, type ClassMembershipProvider } from "../../src/data-scope/data-scope.service";
import { AuthzService } from "../../src/rbac/authz.service";
import { RedisService } from "../../src/redis/redis.service";
import { runInScope } from "../../src/tenancy/request-scope";
import { TenantPrismaService } from "../../src/tenancy/tenant-prisma.service";
import { Harness, type TestUser } from "../helpers/app";

const HR_MENUS = ["hr", "hr:person", "hr:person:edit"];

describe("data scope", () => {
  const h = new Harness();
  let boss: TestUser;
  let bossToken: string;
  let setIds: Record<string, string>;
  const admin = () => h.call(bossToken);
  const dept: Record<string, string> = {};
  const person: Record<string, string> = {};

  async function role(code: string, opts: { menus?: string[]; sets?: string[] } = {}): Promise<string> {
    const menus = (await admin().get("/api/menus")).body as Array<{ id: string; code: string | null }>;
    const byCode = new Map(menus.map((m) => [m.code, m.id]));
    const created = await admin().post("/api/roles", { code, name: code });
    expect(created.status).toBe(201);
    const ticked = (opts.menus ?? HR_MENUS).map((c) => byCode.get(c));
    expect((await admin().put(`/api/roles/${created.body.id}/menus`, { menuIds: ticked })).status).toBe(200);
    expect((await admin().put(`/api/roles/${created.body.id}/data-scopes`, { setIds: (opts.sets ?? []).map((s) => setIds[s] ?? s) })).status).toBe(200);
    return created.body.id;
  }

  async function userWith(username: string, roleCodes: string[], inDepts: string[]): Promise<{ user: TestUser; token: string }> {
    const user = await h.user(username, { roles: roleCodes, person: "staff", deptIds: inDepts.map((d) => dept[d]) });
    person[username] = user.personId as string;
    return { user, token: await user.token() };
  }

  // 只看被查看的人员（p.*）和调用者自己：别的场景里建的 u.* 用户也是人员，会混进来
  const names = async (token: string, me = "") =>
    ((await h.call(token).get("/api/persons")).body as Array<{ fullName: string }>)
      .map((p) => p.fullName)
      .filter((n) => n.startsWith("p.") || n === me)
      .sort();

  beforeAll(async () => {
    await h.start();
    boss = await h.user("boss", { roles: ["tenant-admin"], person: "staff" });
    bossToken = await boss.token();
    const sets = (await admin().get("/api/data-scope-sets")).body as Array<{ id: string; code: string }>;
    setIds = Object.fromEntries(sets.map((s) => [s.code, s.id]));

    const tenantId = h.tenant.tenantId;
    const mk = async (name: string, parent?: string) => {
      dept[name] = (await h.owner.dept.create({ data: { tenantId, name, parentId: parent ? dept[parent] : null } })).id;
    };
    await mk("SH");
    await mk("SH-Math", "SH");
    await mk("SH-Math-A", "SH-Math");
    await mk("BJ");
    await mk("BJ-Art", "BJ");
    // 被查看的人员：在不同部门
    const mkPerson = async (fullName: string, type: "staff" | "student", depts: string[]) => {
      const p = await h.owner.person.create({ data: { tenantId, type, fullName } });
      person[fullName] = p.id;
      for (const d of depts) await h.owner.personDept.create({ data: { tenantId, personId: p.id, deptId: dept[d] } });
    };
    await mkPerson("p.sh", "staff", ["SH"]);
    await mkPerson("p.shm", "staff", ["SH-Math"]);
    await mkPerson("p.shma", "staff", ["SH-Math-A"]);
    await mkPerson("p.bj", "staff", ["BJ"]);
    await mkPerson("p.bja", "staff", ["BJ-Art"]);
    await mkPerson("p.multi", "staff", ["SH-Math", "BJ-Art"]);
    await mkPerson("p.nodept", "staff", []);
    await mkPerson("p.student", "student", ["SH"]);
  });
  afterAll(() => h.stop());

  const ALL_OTHERS = ["p.bj", "p.bja", "p.multi", "p.nodept", "p.sh", "p.shm", "p.shma", "p.student"];

  it("all: sees and edits everyone", async () => {
    await role("r-all", { sets: ["all"] });
    const { token } = await userWith("u.all", ["r-all"], ["SH"]);
    expect(await names(token, "u.all")).toEqual(["u.all", ...ALL_OTHERS].sort());
    expect((await h.call(token).get(`/api/persons/${person["p.bja"]}`)).status).toBe(200);
    expect((await h.call(token).patch(`/api/persons/${person["p.bja"]}`, { fullName: "p.bja" })).status).toBe(200);
  });

  it("own department: only people in the user's own department (not below, not above)", async () => {
    await role("r-dept", { sets: ["own_dept"] });
    const { token } = await userWith("u.dept", ["r-dept"], ["SH-Math"]);
    expect(await names(token, "u.dept")).toEqual(["p.multi", "p.shm", "u.dept"]);
    expect((await h.call(token).patch(`/api/persons/${person["p.shm"]}`, { fullName: "p.shm" })).status).toBe(200);
    expect((await h.call(token).patch(`/api/persons/${person["p.shma"]}`, { fullName: "x" })).status).toBe(404); // 下级部门：范围外
    expect((await h.call(token).patch(`/api/persons/${person["p.sh"]}`, { fullName: "x" })).status).toBe(404); // 上级部门：范围外
    expect((await h.call(token).get(`/api/persons/${person["p.bj"]}`)).status).toBe(404);
  });

  it("own department and below: the whole subtree", async () => {
    await role("r-tree", { sets: ["own_dept_tree"] });
    const { token } = await userWith("u.tree", ["r-tree"], ["SH"]);
    expect(await names(token, "u.tree")).toEqual(["p.multi", "p.sh", "p.shm", "p.shma", "p.student", "u.tree"]);
    expect((await h.call(token).patch(`/api/persons/${person["p.shma"]}`, { fullName: "p.shma" })).status).toBe(200);
    expect((await h.call(token).patch(`/api/persons/${person["p.bj"]}`, { fullName: "x" })).status).toBe(404);
  });

  it("own records only", async () => {
    await role("r-self", { sets: ["self"] });
    const { token, user } = await userWith("u.self", ["r-self"], ["SH"]);
    expect(await names(token, "u.self")).toEqual(["u.self"]);
    expect((await h.call(token).patch(`/api/persons/${user.personId}`, { fullName: "u.self" })).status).toBe(200);
    expect((await h.call(token).patch(`/api/persons/${person["p.sh"]}`, { fullName: "x" })).status).toBe(404);
  });

  it("custom set with 'include children' and without", async () => {
    const dir = (await admin().get("/api/depts")).body as Array<{ id: string; name: string }>;
    expect(dir.length).toBeGreaterThan(0);
    const withKids = (await admin().post("/api/data-scope-sets", { name: "BJ tree", nodes: [{ deptId: dept.BJ, includeChildren: true }] })).body.id;
    const noKids = (await admin().post("/api/data-scope-sets", { name: "SH-Math only", nodes: [{ deptId: dept["SH-Math"], includeChildren: false }] })).body.id;
    await role("r-custom-tree", { sets: [withKids] });
    await role("r-custom-flat", { sets: [noKids] });
    const tree = await userWith("u.ctree", ["r-custom-tree"], []);
    expect(await names(tree.token)).toEqual(["p.bj", "p.bja", "p.multi"]);
    const flat = await userWith("u.cflat", ["r-custom-flat"], []);
    expect(await names(flat.token)).toEqual(["p.multi", "p.shm"]); // 不含下级 SH-Math-A
    expect((await h.call(tree.token).patch(`/api/persons/${person["p.bja"]}`, { fullName: "p.bja" })).status).toBe(200);
    expect((await h.call(flat.token).patch(`/api/persons/${person["p.shma"]}`, { fullName: "x" })).status).toBe(404);
  });

  it("no applicable set means no data (and writes are refused)", async () => {
    await role("r-none", { sets: [] });
    const none = await userWith("u.none", ["r-none"], ["SH"]);
    expect(await names(none.token, "u.none")).toEqual([]);
    expect((await h.call(none.token).patch(`/api/persons/${person["p.sh"]}`, { fullName: "x" })).status).toBe(404);
    // 只有"班级"维度的集：人员表不认班级维度，被忽略，等于没有适用的集
    await role("r-classes", { sets: ["own_classes"] });
    const cls = await userWith("u.cls", ["r-classes"], ["SH"]);
    expect(await names(cls.token, "u.cls")).toEqual([]);
  });

  it("several departments for one person: the union of both", async () => {
    await role("r-dept2", { sets: ["own_dept"] });
    const { token } = await userWith("u.two", ["r-dept2"], ["SH-Math", "BJ-Art"]);
    expect(await names(token, "u.two")).toEqual(["p.bja", "p.multi", "p.shm", "u.two"]);
  });

  it("several roles and several sets: the union", async () => {
    const bjOnly = (await admin().post("/api/data-scope-sets", { name: "BJ root only", nodes: [{ deptId: dept.BJ, includeChildren: false }] })).body.id;
    await role("r-self-2", { sets: ["self"] });
    await role("r-bj-2", { sets: [bjOnly] });
    const { token } = await userWith("u.union", ["r-self-2", "r-bj-2"], []);
    expect(await names(token, "u.union")).toEqual(["p.bj", "u.union"]);
  });

  it("a role without the permission does not widen the scope of this endpoint (S1)", async () => {
    await role("r-hr-self", { sets: ["self"] }); // 有人事权限，范围：仅本人
    await role("r-roles-all", { menus: ["system", "system:role"], sets: ["all"] }); // 没有人事权限，范围：全部
    const { token } = await userWith("u.s1", ["r-hr-self", "r-roles-all"], ["SH"]);
    expect(await names(token, "u.s1")).toEqual(["u.s1"]); // "全部"没有放大人员接口
    expect((await h.call(token).get("/api/roles")).status).toBe(200); // 而它自己的权限仍然有效
  });

  it("the built-in tenant administrator has no business data scope: only staff basic information", async () => {
    const seen = await names(bossToken);
    expect(seen).toContain("p.sh");
    expect(seen).not.toContain("p.student");
    expect((await admin().get(`/api/persons/${person["p.student"]}`)).status).toBe(404);
    expect((await admin().patch(`/api/persons/${person["p.student"]}`, { fullName: "x" })).status).toBe(404);
    expect((await admin().patch(`/api/persons/${person["p.sh"]}`, { fullName: "p.sh" })).status).toBe(200);
  });

  it("changing a role's data scope takes effect on the next request", async () => {
    const roleId = await role("r-live", { sets: ["self"] });
    const { token } = await userWith("u.live", ["r-live"], ["SH"]);
    expect(await names(token, "u.live")).toEqual(["u.live"]);
    expect((await admin().put(`/api/roles/${roleId}/data-scopes`, { setIds: [setIds.own_dept_tree] })).status).toBe(200);
    expect(await names(token, "u.live")).toEqual(["p.multi", "p.sh", "p.shm", "p.shma", "p.student", "u.live"]);
  });

  it("a department move is picked up once the permission version is bumped", async () => {
    await role("r-move", { sets: ["own_dept_tree"] });
    const { token } = await userWith("u.move", ["r-move"], ["BJ"]);
    expect(await names(token, "u.move")).toEqual(["p.bj", "p.bja", "p.multi", "u.move"]);
    await h.owner.dept.update({ where: { id: dept["BJ-Art"] }, data: { parentId: dept.SH } }); // 触发器改写祖先链
    await h.bump(); // 人事调动的写操作会做这一步（B5）
    expect(await names(token, "u.move")).toEqual(["p.bj", "u.move"]);
    await h.owner.dept.update({ where: { id: dept["BJ-Art"] }, data: { parentId: dept.BJ } });
    await h.bump();
  });

  describe("resolver, student and class dimensions", () => {
    const resolverFor = (provider?: ClassMembershipProvider) => {
      const tenantDb = h.app.get(TenantPrismaService);
      const authz = h.app.get(AuthzService);
      const service = new DataScopeService(tenantDb, authz, h.app.get(RedisService), provider);
      const scope = { kind: "tenant" as const, tenantId: h.tenant.tenantId, code: h.tenant.code, name: "t", status: "active" };
      return {
        resolve: (accountId: string, perm: string) =>
          runInScope(scope, async () => service.resolve(h.tenant.tenantId, (await authz.load(h.tenant.tenantId, accountId))!, perm)),
      };
    };

    it("class-scoped sets resolve to the classes the person teaches or attends", async () => {
      await role("r-classes-2", { sets: ["own_classes", "self"] });
      const { user } = await userWith("u.teach", ["r-classes-2"], ["SH"]);
      const resolver = resolverFor({ classIdsFor: async (id) => (id === user.personId ? ["class-1", "class-2"] : []) });
      expect(await resolver.resolve(user.accountId, "hr:person:list")).toEqual({
        all: false,
        deptIds: [],
        selfPersonId: user.personId,
        classIds: ["class-1", "class-2"],
        staffBasic: false,
      });
    });

    it("the built-in student role resolves to the student's own record and classes", async () => {
      const student = await h.user("stu.a", { roles: ["student"], person: "student" });
      // 学生角色的权限来自"学生门户"入口的菜单；此时门户还没有菜单，临时造一个带权限的门户菜单来验证
      const entry = await h.owner.entry.findFirstOrThrow({ where: { code: "portal" } });
      const menu = await h.owner.menu.create({ data: { tenantId: null, name: "Portal test", type: "menu", perms: "portal:test:view", code: `portal-test-${Date.now()}` } });
      await h.owner.entryMenu.create({ data: { tenantId: null, entryId: entry.id, menuId: menu.id } });
      await h.owner.tenantMenuGrant.create({ data: { tenantId: h.tenant.tenantId, menuId: menu.id } });
      await h.bump();
      try {
        const resolver = resolverFor({ classIdsFor: async () => ["class-9"] });
        expect(await resolver.resolve(student.accountId, "portal:test:view")).toMatchObject({
          all: false,
          selfPersonId: student.personId,
          classIds: ["class-9"],
          staffBasic: false,
        });
        // 学生没有后台权限：人员接口 403
        expect((await h.call(await student.token()).get("/api/persons")).status).toBe(403);
      } finally {
        await h.owner.tenantMenuGrant.deleteMany({ where: { menuId: menu.id } });
        await h.owner.entryMenu.deleteMany({ where: { menuId: menu.id } });
        await h.owner.menu.delete({ where: { id: menu.id } });
        await h.bump();
      }
    });

    it("an account holding no role with the permission resolves to the empty scope", async () => {
      const nobody = await h.user("nobody.x", { person: "staff" });
      expect(await resolverFor().resolve(nobody.accountId, "hr:person:list")).toEqual({ all: false, deptIds: [], selfPersonId: null, classIds: [], staffBasic: false });
    });
  });
});
