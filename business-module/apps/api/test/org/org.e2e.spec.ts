// 组织：校区（三态与关闭检查）、部门树、岗位。
import { Harness } from "../helpers/app";

describe("campuses, departments and posts", () => {
  const h = new Harness();
  let bossToken: string;
  const admin = () => h.call(bossToken);
  let campusId: string;
  let campusDeptId: string;

  beforeAll(async () => {
    await h.start();
    bossToken = await (await h.user("boss", { roles: ["tenant-admin"], person: "staff" })).token();
  });
  afterAll(() => h.stop());

  describe("campuses", () => {
    it("creating a campus creates and binds its root department; renaming keeps both in step; the code is fixed", async () => {
      const res = await admin().post("/api/campuses", { code: "SH", name: "Shanghai", timezone: "Asia/Shanghai" });
      expect(res.status).toBe(201);
      campusId = res.body.id;
      campusDeptId = res.body.deptId;
      const dept = await h.owner.dept.findUniqueOrThrow({ where: { id: campusDeptId } });
      expect(dept).toMatchObject({ name: "Shanghai", parentId: null, status: true });
      expect(dept.ancestors).toEqual([campusDeptId]);
      expect(res.body).toMatchObject({ type: "campus", status: "normal" });

      expect((await admin().patch(`/api/campuses/${campusId}`, { name: "Shanghai Pudong" })).status).toBe(200);
      expect((await h.owner.dept.findUniqueOrThrow({ where: { id: campusDeptId } })).name).toBe("Shanghai Pudong");
      expect((await admin().patch(`/api/campuses/${campusId}`, { code: "XX" })).status).toBe(400);
      expect((await admin().post("/api/campuses", { code: "SH", name: "Dup" })).status).toBe(409);
      expect((await admin().post("/api/campuses", { code: "bad code", name: "Bad" })).status).toBe(400);
    });

    it("the headquarters campus cannot be closed or paused", async () => {
      const hq = (await admin().get("/api/campuses")).body.find((c: { type: string }) => c.type === "hq");
      expect((await admin().post(`/api/campuses/${hq.id}/status`, { status: "stop_new" })).status).toBe(403);
    });

    it("follows normal → stop-new → closed → normal, and closing needs the three checks to be clear and the name typed", async () => {
      expect((await admin().post(`/api/campuses/${campusId}/status`, { status: "closed", confirmName: "Shanghai Pudong" })).status).toBe(409); // 不能跳过"停止新增"
      expect((await admin().post(`/api/campuses/${campusId}/status`, { status: "stop_new" })).body.status).toBe("stop_new");

      // 校区下有教职员工任职和学生 → 不能关闭，并列出清单
      const sub = (await admin().post("/api/depts", { name: "Science", parentId: campusDeptId })).body;
      const staff = await h.owner.person.create({ data: { tenantId: h.tenant.tenantId, type: "staff", fullName: "Teacher Zhang" } });
      const student = await h.owner.person.create({ data: { tenantId: h.tenant.tenantId, type: "student", fullName: "Student Li" } });
      await h.owner.personDept.create({ data: { tenantId: h.tenant.tenantId, personId: staff.id, deptId: sub.id } });
      await h.owner.personDept.create({ data: { tenantId: h.tenant.tenantId, personId: student.id, deptId: campusDeptId } });
      const check = (await admin().get(`/api/campuses/${campusId}/closure-check`)).body;
      expect(check).toMatchObject({ canClose: false, students: { count: 1 }, staffAssignments: { count: 1 }, classes: { count: 0, implemented: false } });
      expect(check.students.items[0].fullName).toBe("Student Li");
      const refused = await admin().post(`/api/campuses/${campusId}/status`, { status: "closed", confirmName: "Shanghai Pudong" });
      expect(refused.status).toBe(409);
      expect(refused.body.check.staffAssignments.count).toBe(1);

      await h.owner.personDept.deleteMany({ where: { tenantId: h.tenant.tenantId } });
      expect((await admin().post(`/api/campuses/${campusId}/status`, { status: "closed" })).status).toBe(400); // 要输入校区名称
      expect((await admin().post(`/api/campuses/${campusId}/status`, { status: "closed", confirmName: "wrong" })).status).toBe(400);
      expect((await admin().post(`/api/campuses/${campusId}/status`, { status: "closed", confirmName: "Shanghai Pudong" })).body.status).toBe("closed");
      // 关闭：部门节点及子树自动停用
      expect((await h.owner.dept.findUniqueOrThrow({ where: { id: campusDeptId } })).status).toBe(false);
      expect((await h.owner.dept.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe(false);
      // 关闭后不能再往里加部门
      expect((await admin().post("/api/depts", { name: "Late", parentId: campusDeptId })).status).toBe(400);

      // 重新开放：恢复启用
      expect((await admin().post(`/api/campuses/${campusId}/status`, { status: "normal" })).body.status).toBe("normal");
      expect((await h.owner.dept.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe(true);
      expect((await admin().post(`/api/campuses/${campusId}/status`, { status: "normal" })).status).toBe(409);
    });

    it("changing a campus status needs its own permission; every change is audited", async () => {
      const hr = await h.user("hr.only", { roles: ["hr-manager"], person: "staff" });
      expect((await h.call(await hr.token()).post(`/api/campuses/${campusId}/status`, { status: "stop_new" })).status).toBe(403);
      const logs = (await admin().get("/api/audit-logs?size=100")).body as Array<{ action: string }>;
      expect(logs.filter((l) => l.action === "campus.status").length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("departments", () => {
    let a: string;
    let b: string;

    it("builds a tree under a campus; parents must exist in this tenant; no cycles", async () => {
      a = (await admin().post("/api/depts", { name: "Dept A", parentId: campusDeptId })).body.id;
      b = (await admin().post("/api/depts", { name: "Dept B", parentId: a })).body.id;
      expect((await h.owner.dept.findUniqueOrThrow({ where: { id: b } })).ancestors).toEqual([campusDeptId, a, b]);
      expect((await admin().post("/api/depts", { name: "Orphan", parentId: "11111111-1111-4111-8111-111111111111" })).status).toBe(400);
      expect((await admin().post("/api/depts", { name: "No parent" })).status).toBe(400);
      expect((await admin().patch(`/api/depts/${a}`, { parentId: b })).status).toBe(400); // 不能移到自己的后代之下
      expect((await admin().patch(`/api/depts/${a}`, { parentId: a })).status).toBe(400);
      expect((await admin().patch(`/api/depts/${b}`, { name: "Dept B2", sort: 3 })).body).toMatchObject({ name: "Dept B2", sort: 3 });
    });

    it("moving a department rewrites its subtree's ancestor chain (the GIN index use is verified in dept-tree.int.spec.ts)", async () => {
      const other = (await admin().post("/api/depts", { name: "Dept C", parentId: campusDeptId })).body.id;
      expect((await admin().patch(`/api/depts/${a}`, { parentId: other })).status).toBe(200);
      expect((await h.owner.dept.findUniqueOrThrow({ where: { id: b } })).ancestors).toEqual([campusDeptId, other, a, b]);
      await admin().patch(`/api/depts/${a}`, { parentId: campusDeptId });
    });

    it("a campus root department can be neither renamed, moved, disabled nor deleted directly", async () => {
      expect((await admin().patch(`/api/depts/${campusDeptId}`, { name: "x" })).status).toBe(403);
      expect((await admin().patch(`/api/depts/${campusDeptId}`, { status: false })).status).toBe(403);
      expect((await admin().del(`/api/depts/${campusDeptId}`)).status).toBe(409); // 关联了校区
    });

    it("a department with sub-departments, people or a data scope cannot be deleted — only disabled; a free one can", async () => {
      expect((await admin().del(`/api/depts/${a}`)).status).toBe(409); // 有下级
      const person = await h.owner.person.create({ data: { tenantId: h.tenant.tenantId, type: "staff", fullName: "Assigned" } });
      await h.owner.personDept.create({ data: { tenantId: h.tenant.tenantId, personId: person.id, deptId: b } });
      const blocked = await admin().del(`/api/depts/${b}`);
      expect(blocked.status).toBe(409);
      expect(blocked.body.message).toMatch(/people are assigned/);
      expect((await admin().patch(`/api/depts/${b}`, { status: false })).body.status).toBe(false); // 只能停用
      await h.owner.personDept.deleteMany({ where: { deptId: b } });

      const set = await admin().post("/api/data-scope-sets", { name: "Scope on B", nodes: [{ deptId: b, includeChildren: true }] });
      expect((await admin().del(`/api/depts/${b}`)).body.message ?? "").toMatch(/data scope/);
      await h.owner.dataScopeSetNode.deleteMany({ where: { setId: set.body.id } });
      expect((await admin().del(`/api/depts/${b}`)).status).toBe(200);
      expect((await admin().get(`/api/depts/${b}`)).status).toBe(404);
    });

    it("moving or disabling a department takes effect for data scopes at once (the permission version moves)", async () => {
      const before = Number((await h.redis.get(`perm:v:${h.tenant.tenantId}`)) ?? 0);
      await admin().patch(`/api/depts/${a}`, { sort: 9 }); // 只改排序：不影响数据范围，不加版本号
      expect(Number((await h.redis.get(`perm:v:${h.tenant.tenantId}`)) ?? 0)).toBe(before);
      await admin().patch(`/api/depts/${a}`, { status: false });
      expect(Number((await h.redis.get(`perm:v:${h.tenant.tenantId}`)) ?? 0)).toBeGreaterThan(before);
    });
  });

  describe("posts", () => {
    it("creates, edits, disables and deletes; the code can be reused after deletion", async () => {
      const p = (await admin().post("/api/posts", { code: "instructor", name: "Instructor", sort: 2 })).body;
      expect((await admin().post("/api/posts", { code: "instructor", name: "Again" })).status).toBe(409);
      expect((await admin().post("/api/posts", { code: "Bad Code", name: "x" })).status).toBe(400);
      expect((await admin().patch(`/api/posts/${p.id}`, { name: "Senior instructor", status: false })).body).toMatchObject({ name: "Senior instructor", status: false });
      expect((await admin().patch(`/api/posts/${p.id}`, { code: "x" })).status).toBe(400);
      expect((await admin().del(`/api/posts/${p.id}`)).status).toBe(200);
      expect((await admin().post("/api/posts", { code: "instructor", name: "Reused" })).status).toBe(201);
    });
  });
});
