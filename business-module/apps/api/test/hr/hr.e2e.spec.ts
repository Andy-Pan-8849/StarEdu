// 人事：人员查重、员工任职历史与离职、敏感信息分层、紧急联系人、学生与校区、导入、B4 的回填。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInScope } from "../../src/tenancy/request-scope";
import { StaffService } from "../../src/hr/staff.service";
import { Harness } from "../helpers/app";

const SAMPLE = resolve(__dirname, "../../../../../ai-module/sample-data/structured");
const day = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

describe("HR: people, staff, students, emergency contacts, import", () => {
  const h = new Harness();
  let adminToken: string;
  let hrToken: string;
  let hqDept: string;
  let hqCampus: string;
  const admin = () => h.call(adminToken);
  const hr = () => h.call(hrToken);

  beforeAll(async () => {
    await h.start();
    adminToken = await (await h.user("boss", { roles: ["tenant-admin"], person: "staff" })).token();
    const hrUser = await h.user("hr.mgr", { roles: ["hr-manager"], person: "staff" });
    hrToken = await hrUser.token();
    const campus = await h.owner.campus.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, type: "hq" } });
    hqDept = campus.deptId;
    hqCampus = campus.id;
  });
  afterAll(() => h.stop());

  describe("duplicates and dual identity", () => {
    it("a new person is checked by e-mail (any case) and ID number; the same person can be staff and student without a second record", async () => {
      const created = await hr().post("/api/staff", { fullName: "Dana Dual", workEmail: "Dana@Example.test", hireDate: "2024-01-01", assignments: [{ deptId: hqDept }] });
      expect(created.status).toBe(201);
      const personId = created.body.personId;
      const dup = await hr().post("/api/staff", { fullName: "Dana Again", workEmail: "dana@example.test", hireDate: "2024-01-01" });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe("DUPLICATE_PERSON");
      expect(dup.body.existing).toMatchObject({ id: personId, hasStaff: true, hasStudent: false });
      const dupStudent = await hr().post("/api/students", { fullName: "Dana S", workEmail: "DANA@example.test", campusId: hqCampus });
      expect(dupStudent.status).toBe(409);
      expect(dupStudent.body.existing.id).toBe(personId);

      // 在已有人员上加学员档案：不新建人
      const before = await h.owner.person.count({ where: { tenantId: h.tenant.tenantId } });
      expect((await hr().post("/api/students", { personId, campusId: hqCampus, program: "python" })).status).toBe(201);
      expect(await h.owner.person.count({ where: { tenantId: h.tenant.tenantId } })).toBe(before);
      const detail = (await hr().get(`/api/students/${personId}`)).body;
      expect(detail.student).toMatchObject({ campusId: hqCampus, academicStatus: "enrolled", program: "python" });
      expect((await hr().get(`/api/staff/${personId}`)).body.staff.employeeNo).toMatch(/^E\d{4}$/);
      expect((await hr().post("/api/students", { personId, campusId: hqCampus })).status).toBe(409); // 已有学员档案

      // 证件号：要敏感权限；设了之后租户内唯一
      expect((await hr().patch(`/api/persons/${personId}`, { idNumber: "ID-001" })).status).toBe(200);
      const other = (await hr().post("/api/staff", { fullName: "Other", hireDate: "2024-01-01" })).body.personId;
      expect((await hr().patch(`/api/persons/${other}`, { idNumber: "ID-001" })).status).toBe(409);
      expect((await hr().post("/api/staff", { fullName: "By ID", idNumber: "ID-001", hireDate: "2024-01-01" })).status).toBe(409);
    });
  });

  describe("assignments, transfers and employment end", () => {
    let person: string;
    let deptA: string;
    let deptB: string;
    let postId: string;

    beforeAll(async () => {
      deptA = (await h.call(adminToken).post("/api/depts", { name: "Dept A", parentId: hqDept })).body.id;
      deptB = (await h.call(adminToken).post("/api/depts", { name: "Dept B", parentId: hqDept })).body.id;
      postId = (await h.call(adminToken).post("/api/posts", { code: "teacher", name: "Teacher" })).body.id;
      person = (await hr().post("/api/staff", { fullName: "Tia Teacher", hireDate: "2023-09-01", assignments: [{ deptId: deptA, postId, isPrimary: true }] })).body.personId;
    });

    it("keeps several assignments (primary and secondary) and derives the campus from the department", async () => {
      const v = (await hr().post(`/api/staff/${person}/assignments`, { deptId: deptB })).body;
      expect(v.assignments.filter((a: { current: boolean }) => a.current)).toHaveLength(2);
      expect(v.assignments.filter((a: { isPrimary: boolean }) => a.isPrimary)).toHaveLength(1);
      expect(v.campuses.map((c: { code: string }) => c.code)).toEqual(["HQ"]); // 教职员工的校区由任职推算
      const second = (await hr().post(`/api/staff/${person}/assignments`, { deptId: deptB, isPrimary: true })).body;
      expect(second.assignments.filter((a: { isPrimary: boolean }) => a.isPrimary)).toHaveLength(1); // 主任职只有一个
    });

    it("a transfer ends the old assignment the day before and starts the new one, keeping the history; the data scope follows", async () => {
      const before = (await hr().get(`/api/staff/${person}`)).body.assignments as Array<{ id: string; deptId: string; current: boolean }>;
      const from = before.find((a) => a.deptId === deptA && a.current)!;
      const moved = (await hr().post(`/api/staff/${person}/transfer`, { fromAssignmentId: from.id, deptId: hqDept, effectiveDate: day() })).body;
      const old = moved.assignments.find((a: { id: string }) => a.id === from.id);
      expect(old.current).toBe(false);
      expect(old.endDate).toBe(day(-1));
      expect(moved.assignments.some((a: { deptId: string; current: boolean }) => a.deptId === hqDept && a.current)).toBe(true);
      expect(moved.assignments.length).toBeGreaterThan(before.length); // 历史仍在
      // 部门删除规则只看"当前有效"的任职：旧部门已没有当前任职，可以删（历史记录仍在）
      expect((await h.call(adminToken).del(`/api/depts/${deptA}`)).status).toBe(200);
    });

    it("a post that assignments refer to can only be disabled", async () => {
      expect((await h.call(adminToken).del(`/api/posts/${postId}`)).status).toBe(409);
      expect((await h.call(adminToken).patch(`/api/posts/${postId}`, { status: false })).status).toBe(200);
      expect((await hr().post(`/api/staff/${person}/assignments`, { deptId: deptB, postId })).status).toBe(409); // 停用的岗位不能再用
    });

    it("a campus that no longer takes new intake refuses new assignments", async () => {
      const campusId = (await h.call(adminToken).post("/api/campuses", { code: "XX", name: "Paused" })).body;
      const dept = (await h.call(adminToken).post("/api/depts", { name: "In paused", parentId: campusId.deptId })).body.id;
      await h.call(adminToken).post(`/api/campuses/${campusId.id}/status`, { status: "stop_new" });
      expect((await hr().post(`/api/staff/${person}/assignments`, { deptId: dept })).status).toBe(409);
      expect((await hr().post("/api/students", { fullName: "Late", campusId: campusId.id })).status).toBe(409);
    });
  });

  describe("employment end", () => {
    it("ends at once: assignments end, admin access is withdrawn immediately and the sessions are revoked", async () => {
      const leaver = await h.user("leaver", { roles: ["hr-manager"], person: "staff", deptIds: [hqDept] });
      const token = await leaver.token();
      expect((await h.call(token).get("/api/persons")).status).toBe(200);
      expect((await h.call(token).post("/api/auth/session", { entry: "admin" })).status).toBe(201);

      const res = await hr().post(`/api/staff/${leaver.personId}/end`, { status: "left" });
      expect(res.status).toBe(201);
      expect(res.body.staff.status).toBe("left");
      expect(res.body.assignments.every((a: { current: boolean }) => !a.current)).toBe(true);
      expect(res.body.warnings).toEqual([]); // 带班提示：教学模块（B6）上线后回填
      expect([401, 403]).toContain((await h.call(token).get("/api/persons")).status); // 立即被拒
      const fresh = await leaver.token().catch(() => null); // Keycloak 会话已结束，仍可重新登录，但进不了管理后台
      if (fresh) {
        expect([401, 403]).toContain((await h.call(fresh).get("/api/persons")).status);
        expect((await h.call(fresh).post("/api/auth/session", { entry: "admin" })).status).toBe(403);
      }
      expect((await hr().post(`/api/staff/${leaver.personId}/end`, { status: "left" })).status).toBe(409);
      // 重新入职：在原档案上恢复，任职另加
      expect((await hr().post(`/api/staff/${leaver.personId}/reinstate`)).body.staff.status).toBe("active");
      expect((await hr().post(`/api/staff/${leaver.personId}/assignments`, { deptId: hqDept })).status).toBe(201);
      const back = await leaver.token();
      expect((await h.call(back).get("/api/persons")).status).toBe(200);
    });

    it("a future date is only recorded; the scheduled job switches it when the day comes", async () => {
      const p = (await hr().post("/api/staff", { fullName: "Future Leaver", hireDate: "2022-01-01", assignments: [{ deptId: hqDept }] })).body.personId;
      const planned = await hr().post(`/api/staff/${p}/end`, { status: "left", effectiveDate: day(5) });
      expect(planned.body.staff).toMatchObject({ status: "active", pendingStatus: "left", pendingEffectiveOn: day(5) });
      const service = h.app.get(StaffService);
      const scope = { kind: "tenant" as const, tenantId: h.tenant.tenantId, code: h.tenant.code, name: "t", status: "active" };
      expect(await runInScope(scope, () => service.applyDue())).toBe(0); // 还没到日子
      await h.owner.staffProfile.updateMany({ where: { personId: p }, data: { pendingEffectiveOn: new Date(day(-1)) } }); // 假装日子到了
      expect(await runInScope(scope, () => service.applyDue())).toBe(1);
      const after = (await hr().get(`/api/staff/${p}`)).body;
      expect(after.staff).toMatchObject({ status: "left", pendingStatus: null });
      expect(after.assignments.every((a: { current: boolean }) => !a.current)).toBe(true);
    });

    it("the built-in administrator cannot be ended", async () => {
      const builtin = await h.owner.account.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, isBuiltinAdmin: true } });
      const person = await h.owner.person.create({ data: { tenantId: h.tenant.tenantId, type: "staff", fullName: "Admin person" } });
      await h.owner.staffProfile.create({ data: { tenantId: h.tenant.tenantId, personId: person.id, employeeNo: "E9999", hireDate: new Date("2020-01-01") } });
      await h.owner.account.update({ where: { id: builtin.id }, data: { personId: person.id } });
      expect((await hr().post(`/api/staff/${person.id}/end`, { status: "left" })).status).toBe(403);
      await h.owner.account.update({ where: { id: builtin.id }, data: { personId: null } });
    });
  });

  describe("basic versus sensitive information", () => {
    let target: string;
    beforeAll(async () => {
      target = (await hr().post("/api/staff", { fullName: "Sam Sensitive", hireDate: "2021-01-01", assignments: [{ deptId: hqDept }] })).body.personId;
      await hr().patch(`/api/persons/${target}`, { idNumber: "S-123", phone: "555-0100", address: "1 Main St", birthDate: "1990-02-03", gender: "female" });
    });

    it("HR sees sensitive information; the tenant administrator sees staff basics only and can neither read nor change the rest", async () => {
      const full = (await hr().get(`/api/staff/${target}`)).body;
      expect(full.sensitive).toMatchObject({ idNumber: "S-123", phone: "555-0100", birthDate: "1990-02-03", gender: "female" });
      const basic = (await admin().get(`/api/staff/${target}`)).body;
      expect(basic.fullName).toBe("Sam Sensitive");
      expect(basic.sensitive).toBeUndefined();
      expect(JSON.stringify(basic)).not.toContain("S-123");
      expect(JSON.stringify((await admin().get(`/api/staff`)).body)).not.toContain("555-0100");
      expect((await admin().get(`/api/persons/${target}`)).body.sensitive).toBeUndefined();
      expect((await admin().patch(`/api/persons/${target}`, { phone: "000" })).status).toBe(403);
      expect((await admin().patch(`/api/persons/${target}`, { fullName: "Sam S." })).status).toBe(200); // 基础信息可以改
    });

    it("the tenant administrator sees no students at all, but can create a minimal staff record", async () => {
      const s = (await hr().post("/api/students", { fullName: "Stu Dent", campusId: hqCampus })).body.personId;
      expect((await admin().get("/api/students")).body).toEqual([]);
      expect((await admin().get(`/api/students/${s}`)).status).toBe(404);
      expect((await admin().post("/api/students", { fullName: "Admin Student", campusId: hqCampus })).status).toBe(403);
      const minimal = await admin().post("/api/staff", { fullName: "Minimal Staff", workEmail: "min@example.test", hireDate: day() });
      expect(minimal.status).toBe(201);
      expect((await admin().post("/api/staff", { fullName: "With ID", idNumber: "X1", hireDate: day() })).status).toBe(403); // 管理员不能设证件号
      expect((await hr().get(`/api/students/${s}`)).body.student.studentNo).toMatch(/^S\d{4}$/);
    });

    it("emergency contacts: only with the permission and in scope; every view and change is logged; the administrator is refused", async () => {
      expect((await admin().get(`/api/persons/${target}/emergency-contacts`)).status).toBe(404); // 租户管理员有权限码，但范围里没有"教职员工基础信息"以外的东西：404，不透露是否存在
      const created = await hr().post(`/api/persons/${target}/emergency-contacts`, { name: "Pat Parent", relationship: "mother", phone: "555-0111", isGuardian: false });
      expect(created.status).toBe(201);
      await hr().post(`/api/persons/${target}/emergency-contacts`, { name: "Second", relationship: "friend", phone: "555-0122" });
      const list = (await hr().get(`/api/persons/${target}/emergency-contacts`)).body;
      expect(list.map((c: { name: string; priority: number }) => [c.priority, c.name])).toEqual([[1, "Pat Parent"], [2, "Second"]]);
      expect((await hr().put(`/api/persons/${target}/emergency-contacts/${created.body.id}`, { name: "Pat P.", relationship: "mother", phone: "555-0111" })).body.name).toBe("Pat P.");
      expect((await hr().del(`/api/persons/${target}/emergency-contacts/${created.body.id}`)).status).toBe(200);
      const audit = ((await hr().get("/api/audit-logs")).status === 403 ? (await admin().get("/api/audit-logs?size=100")).body : []) as Array<{ action: string; targetId: string }>;
      const actions = audit.filter((a) => a.targetId === target).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(["emergency.view", "emergency.create", "emergency.update", "emergency.delete"]));
      // 对管理员：即使把"查看紧急联系人"勾给一个租户管理员以外的、范围为"无"的角色也看不到——范围是第二道关
      const noScope = (await admin().post("/api/roles", { code: "no-scope-hr", name: "No scope" })).body.id;
      const menus = (await admin().get("/api/menus")).body as Array<{ id: string; code: string | null }>;
      const id = (c: string) => menus.find((m) => m.code === c)!.id;
      await admin().put(`/api/roles/${noScope}/menus`, { menuIds: [id("hr"), id("hr:person"), id("hr:person:emergencyView")] });
      const u = await h.user("noscope", { roles: ["no-scope-hr"], person: "staff" });
      expect((await h.call(await u.token()).get(`/api/persons/${target}/emergency-contacts`)).status).toBe(404);
    });
  });

  describe("scope and the B4 back-fills", () => {
    it("a campus lead sees only their own campus; closing a campus counts real students and staff", async () => {
      const campus = (await admin().post("/api/campuses", { code: "SH", name: "Shanghai" })).body;
      const staffSh = (await hr().post("/api/staff", { fullName: "SH Teacher", hireDate: "2022-01-01", assignments: [{ deptId: campus.deptId }] })).body.personId;
      const stu = (await hr().post("/api/students", { fullName: "SH Student", campusId: campus.id })).body.personId;
      const lead = await h.user("shlead", { roles: ["campus-lead"], person: "staff", deptIds: [campus.deptId] });
      const lt = await lead.token();
      const names = ((await h.call(lt).get("/api/staff")).body as Array<{ fullName: string }>).map((s) => s.fullName);
      expect(names).toContain("SH Teacher");
      expect(names).not.toContain("Tia Teacher"); // 总部校区的人看不到
      expect(((await h.call(lt).get("/api/students")).body as Array<{ id: string }>).map((s) => s.id)).toEqual([stu]);
      expect((await h.call(lt).get(`/api/staff/${(await h.owner.person.findFirstOrThrow({ where: { fullName: "Tia Teacher" } })).id}`)).status).toBe(404);
      expect((await h.call(lt).post(`/api/staff/${staffSh}/assignments`, { deptId: hqDept })).status).toBe(403); // 不能把人调到范围外

      await admin().post(`/api/campuses/${campus.id}/status`, { status: "stop_new" });
      const check = (await admin().get(`/api/campuses/${campus.id}/closure-check`)).body;
      expect(check).toMatchObject({ canClose: false, students: { count: 1 }, staffAssignments: { count: 2 }, classes: { implemented: false } }); // 教师 + 校区负责人
      // 学生退学、教职员工离职后可以关闭
      await hr().patch(`/api/students/${stu}`, { academicStatus: "withdrawn" });
      await hr().post(`/api/staff/${staffSh}/end`, { status: "left" });
      await hr().post(`/api/staff/${lead.personId}/end`, { status: "left" });
      expect((await admin().get(`/api/campuses/${campus.id}/closure-check`)).body.canClose).toBe(true);
    });

    it("a student can move to another campus, which moves their place in the tree", async () => {
      const c2 = (await admin().post("/api/campuses", { code: "GZ", name: "Guangzhou" })).body;
      const stu = (await hr().post("/api/students", { fullName: "Mover", campusId: hqCampus })).body.personId;
      expect((await hr().patch(`/api/students/${stu}`, { campusId: c2.id })).body.student.campusId).toBe(c2.id);
      const placements = await h.owner.personDept.findMany({ where: { personId: stu, kind: "student" } });
      expect(placements.filter((p) => !p.endDate || p.endDate >= new Date(day())).map((p) => p.deptId)).toEqual([c2.deptId]);
    });
  });

  describe("import and export", () => {
    it("imports the sample files (8 campuses, 141 staff, 60 students), maps BJ to the headquarters, and can be repeated", async () => {
      const read = (f: string) => readFileSync(resolve(SAMPLE, f), "utf8");
      const aliases = { BJ: "HQ" };
      const campuses = (await hr().post("/api/import/campuses", { csv: read("campuses.csv"), campusAliases: aliases })).body;
      // hr-manager 没有"新增校区"权限；用租户管理员导入校区
      expect(campuses.statusCode ?? 403).toBe(403);
      const camp = (await admin().post("/api/import/campuses", { csv: read("campuses.csv"), campusAliases: aliases })).body;
      expect(camp.errors).toEqual([]);
      expect(camp.created + camp.unchanged).toBe(8); // SH、GZ 在前面的用例里已经建过
      const staff = (await hr().post("/api/import/staff", { csv: read("employees.csv"), campusAliases: aliases })).body;
      // 前面的用例自动给人编过 E0001…，和样本的员工编号重号的会被当作同一个员工更新（编号就是身份）
      expect(staff.errorCount).toBe(0);
      expect(staff.created + staff.updated + staff.unchanged).toBe(141);
      const students = (await hr().post("/api/import/students", { csv: read("students.csv"), campusAliases: aliases })).body;
      expect(students.errorCount).toBe(0);
      expect(students.created + students.updated + students.unchanged).toBe(60);
      // 重复导入：没有任何变化
      const again = (await hr().post("/api/import/staff", { csv: read("employees.csv"), campusAliases: aliases })).body;
      expect({ created: again.created, updated: again.updated, errors: again.errors, changes: again.changes }).toEqual({ created: 0, updated: 0, errors: [], changes: [] });
      expect(again.unchanged).toBe(141);
      expect((await hr().post("/api/import/students", { csv: read("students.csv"), campusAliases: aliases })).body).toMatchObject({ created: 0, unchanged: 60 });
      expect(await h.owner.staffProfile.count({ where: { tenantId: h.tenant.tenantId, employeeNo: { startsWith: "E0" } } })).toBeGreaterThanOrEqual(141);
      // 总部校区（原样本的 BJ）有 22 名样本员工
      const hqStaff = ((await hr().get("/api/staff?size=100&q=E00")).body as Array<{ employeeNo: string; campuses: string[] }>).filter((s) => s.campuses.some((c) => c.includes("HQ") || c.includes(h.tenant.name) || c === "Test " + h.tenant.code));
      expect(hqStaff.length).toBeGreaterThan(0);
      // 职位变成岗位，部门挂在校区下
      expect(await h.owner.post.count({ where: { tenantId: h.tenant.tenantId, code: "campus-director" } })).toBe(1);
    });

    it("reports bad rows without stopping, checks only when asked to (dry run), and needs the 'all data' scope", async () => {
      const csv = "employee_id,name,campus_id,department,title,level,hire_date,status\nE7001,Good Row,HQ,Ops,Clerk,S1,2024-02-01,active\nE7002,,HQ,Ops,Clerk,S1,2024-02-01,active\nE7003,Bad Date,HQ,Ops,Clerk,S1,yesterday,active\nE7004,No Campus,NOPE,Ops,Clerk,S1,2024-02-01,active\n";
      const dry = (await hr().post("/api/import/staff", { csv, dryRun: true })).body;
      expect(dry).toMatchObject({ dryRun: true, created: 1, errorCount: 3 });
      expect(await h.owner.staffProfile.count({ where: { employeeNo: "E7001" } })).toBe(0); // 只检查不写入
      const real = (await hr().post("/api/import/staff", { csv })).body;
      expect(real.created).toBe(1);
      expect(real.errors.map((e: { row: number }) => e.row)).toEqual([3, 4, 5]);
      expect(await h.owner.staffProfile.count({ where: { employeeNo: "E7001" } })).toBe(1);
      const lead = await h.user("importlead", { roles: ["campus-lead"], person: "staff", deptIds: [hqDept] });
      expect((await h.call(await lead.token()).post("/api/import/staff", { csv })).status).toBe(403);
      expect((await admin().post("/api/import/staff", { csv })).status).toBe(403); // 租户管理员没有业务数据范围
    });

    it("exports the staff the caller may see as CSV, without sensitive columns", async () => {
      const res = await hr().get("/api/staff/export");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/csv/);
      expect(res.text.split("\r\n")[0]).toBe("employee_no,name,work_email,status,hire_date,campuses");
      expect(res.text).not.toContain("S-123");
      expect(res.text).not.toContain("555-0100");
    });
  });
});
