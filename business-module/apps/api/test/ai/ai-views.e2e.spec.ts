// AI 视图（业务模式）：对同一批账号，业务接口看到的行和 AI 视图看到的行必须完全相同——不多（越权为 0）也不少。
// 账号涵盖：集团教务（全部）、校区负责人（本校区）、跨校任教的老师、自定义校区范围的角色、集团人事、学生、内置管理员。
// 另测：租户隔离、一条查询改不了自己的身份设置、没设置身份时一行都看不到。
import { PrismaClient } from "../../src/generated/prisma";
import { Harness } from "../helpers/app";

interface AuthedUser {
  accountId: string;
  personId: string | null;
  username: string;
  token: string;
}

const KEY = "test-internal-key";
const iso = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

function readerClient(): PrismaClient {
  const url = new URL((process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL) as string);
  url.username = "ai_reader";
  url.password = "starit-ai-biz";
  return new PrismaClient({ datasourceUrl: url.toString() });
}

describe("AI views over business tables (business mode)", () => {
  const h = new Harness();
  const reader = readerClient();
  let hqCampus: string;
  let hqDept: string;
  let shCampus: string;
  let shDept: string;
  let boss: string;
  const sections: Record<string, string> = {};
  const users: Record<string, AuthedUser> = {};
  const stu: Record<string, AuthedUser> = {};

  type Authz = { tenantId: string; personId: string | null; scopes: Record<string, unknown> };
  const authzOf = async (token: string): Promise<Authz> => (await h.call(token).post("/api/internal/authz").set("x-internal-key", KEY)).body;

  /** 和 AI 模块一样：事务里写入身份设置 → 切到 ai_sql_ro → 查视图。 */
  async function view(authz: Authz | null, name: string, settings: Record<string, string> = {}) {
    return reader.$transaction(async (tx) => {
      const values: Record<string, string> = authz ? { "app.tenant_id": authz.tenantId, "app.person_id": authz.personId ?? "", "app.scopes": JSON.stringify(authz.scopes) } : {};
      for (const [k, v] of Object.entries({ ...values, ...settings })) await tx.$queryRaw`SELECT set_config(${k}, ${v}, true)`;
      await tx.$executeRawUnsafe("SET LOCAL ROLE ai_sql_ro");
      return tx.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT * FROM ai_sql.${name}`);
    });
  }
  const ids = (rows: Array<Record<string, unknown>>, key: string) => rows.map((r) => String(r[key])).sort();

  async function mkUser(name: string, opts: Parameters<Harness["user"]>[1]): Promise<AuthedUser> {
    const u = await h.user(name, opts);
    return { accountId: u.accountId, personId: u.personId, username: u.username, token: await u.token() };
  }

  beforeAll(async () => {
    process.env.INTERNAL_API_KEY = KEY;
    await h.start();
    const campus = await h.owner.campus.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, type: "hq" } });
    hqCampus = campus.id;
    hqDept = campus.deptId;
    boss = await (await h.user("boss", { roles: ["tenant-admin"], person: "staff" })).token();
    const sh = (await h.call(boss).post("/api/campuses", { code: "SH", name: "Shanghai", timezone: "Asia/Shanghai" })).body;
    shCampus = sh.id;
    shDept = sh.deptId;

    users.reg = await mkUser("reg.all", { roles: ["academic-manager"], person: "staff", deptIds: [hqDept] }); // 集团教务：全部
    users.lead = await mkUser("lead.hq", { roles: ["campus-lead"], person: "staff", deptIds: [hqDept] }); // 校区负责人：本校区
    users.cross = await mkUser("cross.t1", { roles: ["teacher"], person: "staff", deptIds: [hqDept] }); // 跨校任教
    users.t2 = await mkUser("sh.t2", { roles: ["teacher"], person: "staff", deptIds: [shDept] });
    users.t3 = await mkUser("hq.t3", { roles: ["teacher"], person: "staff", deptIds: [hqDept] });
    users.hr = await mkUser("hr.group", { roles: ["hr-manager"], person: "staff", deptIds: [hqDept] }); // 集团人事：全部学生
    users.custom = await mkUser("custom.sh", { person: "staff", deptIds: [hqDept] }); // 自定义范围：只有上海校区
    users.admin = await mkUser("boss2", { roles: ["tenant-admin"], person: "staff" });

    // 自定义角色：教务菜单（学生、班级、选课、作业、提交、成绩）+ 只覆盖上海校区的数据权限集
    const tree = (await h.call(boss).get("/api/roles/menu-tree")).body as Array<{ id: string; code: string; children?: unknown[] }>;
    const flat: Array<{ id: string; code: string }> = [];
    const walk = (nodes: Array<{ id: string; code: string; children?: unknown[] }>) => nodes.forEach((n) => { flat.push(n); walk((n.children ?? []) as never); });
    walk(tree);
    const wanted = ["hr", "hr:student", "edu", "edu:section", "edu:section:roster", "edu:section:assignments", "edu:section:submissions", "edu:section:gradebook"];
    const role = (await h.call(boss).post("/api/roles", { code: "sh-registrar", name: "Shanghai registrar" })).body;
    await h.call(boss).put(`/api/roles/${role.id}/menus`, { menuIds: flat.filter((m) => wanted.includes(m.code)).map((m) => m.id) });
    const set = (await h.call(boss).post("/api/data-scope-sets", { name: "Shanghai only", nodes: [{ deptId: shDept, includeChildren: true }] })).body;
    await h.call(boss).put(`/api/roles/${role.id}/data-scopes`, { setIds: [set.id] });
    await h.call(boss).put(`/api/accounts/${users.custom.accountId}/roles`, { roleIds: [role.id] });
    await h.bump();

    // 学期、课程、班级：HQ 两个班，SH 两个班；跨校老师在 HQ 和 SH 各教一个
    const reg = () => h.call(users.reg.token);
    const termId = (await reg().post("/api/terms", { code: "2026F", name: "2026 Fall", startDate: iso(-10), endDate: iso(80), enrollOpenDate: iso(-5), enrollCloseDate: iso(10), dropDeadline: iso(20) })).body.id;
    await reg().post(`/api/terms/${termId}/status`, { status: "enrolling" });
    const course = async (code: string) => (await reg().post("/api/courses", { code, name: code, credits: 3 })).body.id as string;
    const mk = async (key: string, code: string, campusId: string, teachers: string[]) => {
      const id = (await reg().post("/api/sections", { courseId: await course(code), termId, campusId, number: "01", capacity: 20, schedule: [] })).body.id as string;
      await reg().put(`/api/sections/${id}/instructors`, { items: teachers.map((t, i) => ({ personId: t, role: i ? "assistant" : "lead" })) });
      await reg().post(`/api/sections/${id}/status`, { status: "open" });
      sections[key] = id;
    };
    await mk("hq1", "CS101", hqCampus, [users.cross.personId as string]);
    await mk("hq2", "CS102", hqCampus, [users.t3.personId as string]);
    await mk("sh1", "CS201", shCampus, [users.cross.personId as string, users.t2.personId as string]);
    await mk("sh2", "CS202", shCampus, [users.t2.personId as string]);

    // 学生：HQ 两个、SH 两个（归属对应校区的部门）
    for (const [name, campusId, deptId] of [["stu.a", hqCampus, hqDept], ["stu.b", hqCampus, hqDept], ["stu.c", shCampus, shDept], ["stu.d", shCampus, shDept]] as const) {
      const u = await mkUser(name, { roles: ["student"], person: "student" });
      await h.owner.studentProfile.updateMany({ where: { personId: u.personId as string }, data: { campusId } });
      await h.owner.personDept.updateMany({ where: { personId: u.personId as string, kind: "student" }, data: { deptId } });
      stu[name] = u;
    }
    await h.bump();
    const enroll = async (sec: string, names: string[]) => expect((await reg().post(`/api/sections/${sec}/enrollments`, { studentIds: names.map((n) => stu[n].personId) })).body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    await enroll(sections.hq1, ["stu.a", "stu.b"]);
    await enroll(sections.hq2, ["stu.b"]);
    await enroll(sections.sh1, ["stu.c", "stu.d"]);
    await enroll(sections.sh2, ["stu.d"]);

    // 作业：每个班一个已发布、一个草稿；提交：部分已评分并发布，部分只提交；最终成绩：部分已发布，部分草稿
    const teacherToken = async (sec: string) => (sec === sections.sh2 ? users.t2.token : sec === sections.hq2 ? users.t3.token : users.cross.token);
    for (const [key, sec] of Object.entries(sections)) {
      const t = h.call(await teacherToken(sec));
      const create = async (title: string, publish: boolean) => {
        const a = (await t.post(`/api/sections/${sec}/assignments`, { title, dueDate: iso(5), rubric: [{ title: "Work", maxPoints: 10 }] })).body.id as string;
        if (publish) await t.post(`/api/sections/${sec}/assignments/${a}/publish`, { published: true });
        return a;
      };
      sections[`${key}.a`] = await create(`${key} published`, true);
      await create(`${key} draft`, false);
    }
    const submit = async (name: string, a: string, text: string) => h.call(stu[name].token).post(`/api/portal/assignments/${a}/submissions`, { text });
    for (const [name, key] of [["stu.a", "hq1"], ["stu.b", "hq1"], ["stu.c", "sh1"], ["stu.d", "sh1"], ["stu.d", "sh2"]] as const) await submit(name, sections[`${key}.a`], "answer");
    // 评分并发布其中一部分
    const grade = async (key: string, name: string, publish: boolean) => {
      const sec = sections[key];
      const t = h.call(await teacherToken(sec));
      const rows = (await t.get(`/api/sections/${sec}/assignments/${sections[`${key}.a`]}/submissions`)).body.rows as Array<{ studentPersonId: string; submissionId: string | null }>;
      const sub = rows.find((r) => r.studentPersonId === stu[name].personId)!.submissionId!;
      const item = ((await t.get(`/api/sections/${sec}/assignments/${sections[`${key}.a`]}`)).body.rubric as Array<{ id: string }>)[0].id;
      await t.put(`/api/sections/${sec}/assignments/${sections[`${key}.a`]}/submissions/${sub}/grade`, { scores: [{ rubricItemId: item, points: 8 }] });
      if (publish) await t.post(`/api/sections/${sec}/assignments/${sections[`${key}.a`]}/submissions/${sub}/publish`);
    };
    await grade("hq1", "stu.a", true);
    await grade("hq1", "stu.b", false);
    await grade("sh1", "stu.c", true);
    for (const [sec, name, published] of [[sections.hq1, "stu.a", true], [sections.hq1, "stu.b", false], [sections.sh1, "stu.c", true], [sections.sh1, "stu.d", false]] as const) {
      const e = await h.owner.enrollment.findFirstOrThrow({ where: { sectionId: sec, studentPersonId: stu[name].personId as string } });
      await h.owner.finalGrade.create({ data: { tenantId: h.tenant.tenantId, enrollmentId: e.id, total: 80, grade: "B", gradePoints: 3, passed: true, publishedAt: published ? new Date() : null } });
    }
    await h.bump();
  }, 180_000);

  afterAll(async () => {
    delete process.env.INTERNAL_API_KEY;
    await reader.$disconnect();
    await h.stop();
  });

  /** 业务接口看到的班级（不看权限，直接试每个班）：能访问的集合。 */
  async function visibleSections(token: string, path: (sec: string) => string, pick: (body: unknown) => string[] = () => []) {
    const out: string[] = [];
    for (const sec of Object.entries(sections).filter(([k]) => !k.includes(".")).map(([, v]) => v)) {
      const res = await h.call(token).get(path(sec));
      if (res.status === 200) out.push(...(pick(res.body).length ? pick(res.body) : []));
    }
    return out.sort();
  }

  describe.each([["reg", "集团教务（全部）"], ["lead", "校区负责人（本校区）"], ["cross", "跨校任教的老师"], ["t2", "上海的老师"], ["hr", "集团人事"], ["custom", "自定义范围（只有上海校区）"], ["admin", "内置管理员"]] as const)("staff account: %s (%s)", (key, _label) => {
    let authz: Authz;
    let token: string;
    beforeAll(async () => {
      token = users[key].token;
      authz = await authzOf(token);
    });

    it("students: the same people as the business API", async () => {
      const api = (await h.call(token).get("/api/students?size=100")).body;
      expect(ids(await view(authz, "students"), "person_id")).toEqual(Array.isArray(api) ? api.map((r: { id: string }) => r.id).sort() : []);
    });

    it("sections: the same classes as the business API", async () => {
      const api = (await h.call(token).get("/api/sections")).body;
      expect(ids(await view(authz, "sections"), "section_id")).toEqual(Array.isArray(api) ? api.map((r: { id: string }) => r.id).sort() : []);
    });

    it("enrollments, assignments, submissions and grades: the same rows as the rosters, assignment lists, submission lists and grade books", async () => {
      const enrollments = await visibleSections(token, (s) => `/api/sections/${s}/roster`, (b) => (b as Array<{ id: string }>).map((r) => r.id));
      expect(ids(await view(authz, "enrollments"), "enrollment_id")).toEqual(enrollments);
      const assignments = await visibleSections(token, (s) => `/api/sections/${s}/assignments`, (b) => (b as Array<{ id: string }>).map((r) => r.id));
      expect(ids(await view(authz, "assignments"), "assignment_id")).toEqual(assignments);
      const subs: string[] = [];
      for (const a of assignments) {
        for (const sec of Object.entries(sections).filter(([k]) => !k.includes(".")).map(([, v]) => v)) {
          const res = await h.call(token).get(`/api/sections/${sec}/assignments/${a}/submissions`);
          if (res.status === 200) subs.push(...(res.body.rows as Array<{ submissionId: string | null }>).flatMap((r) => (r.submissionId ? [r.submissionId] : [])));
        }
      }
      expect(ids(await view(authz, "submissions"), "submission_id")).toEqual([...new Set(subs)].sort());
      const grades = await visibleSections(token, (s) => `/api/sections/${s}/gradebook`, (b) => (b as { students: Array<{ enrollmentId: string; final: unknown }> }).students.filter((s) => s.final).map((s) => s.enrollmentId));
      expect(ids(await view(authz, "final_grades"), "enrollment_id")).toEqual(grades);
    });
  });

  it("the interesting accounts see what we expect (so the comparison above is not comparing two empty sets)", async () => {
    const count = async (key: string, name: string) => (await view(await authzOf(users[key].token), name)).length;
    expect(await count("reg", "students")).toBe(4);
    expect(await count("reg", "sections")).toBe(4);
    expect(await count("lead", "students")).toBe(2); // 本校区
    expect(await count("cross", "sections")).toBe(2); // 跨校：HQ 一个、SH 一个
    expect(await count("custom", "students")).toBe(2); // 自定义：只有上海
    expect(await count("hr", "students")).toBe(4); // 集团人事：全部学生
    expect(await count("hr", "sections")).toBe(0); // 人事没有班级权限
    expect(await count("admin", "students")).toBe(0); // 内置管理员看不到业务数据
    expect(await count("admin", "sections")).toBe(0);
  });

  describe.each(["stu.a", "stu.b", "stu.c", "stu.d"])("student %s sees only their own, through the same rules as the portal", (name) => {
    it("matches the portal", async () => {
      const authz = await authzOf(stu[name].token);
      const call = (p: string) => h.call(stu[name].token).get(p);
      const mine = (await call("/api/portal/my-enrollments")).body as Array<{ id: string; section: { id: string } }>;
      expect(ids(await view(authz, "enrollments"), "enrollment_id")).toEqual(mine.map((e) => e.id).sort());
      expect(ids(await view(authz, "sections"), "section_id")).toEqual([...new Set(mine.map((e) => e.section.id))].sort());
      expect(ids(await view(authz, "students"), "person_id")).toEqual([stu[name].personId]);
      const assignments = (await call("/api/portal/assignments")).body as Array<{ id: string; status: string }>;
      expect(ids(await view(authz, "assignments"), "assignment_id")).toEqual(assignments.map((a) => a.id).sort());
      expect((await view(authz, "submissions")).length).toBe(assignments.filter((a) => a.status !== "missing").length);
      const grades = (await call("/api/portal/grades")).body.terms.flatMap((t: { rows: Array<{ enrollmentId: string; state: string }> }) => t.rows).filter((r: { state: string }) => r.state === "graded");
      expect(ids(await view(authz, "final_grades"), "enrollment_id")).toEqual(grades.map((r: { enrollmentId: string }) => r.enrollmentId).sort());
    });
  });

  it("a student sees the score of a submission only after it is published", async () => {
    const b = await authzOf(stu["stu.b"].token); // stu.b 的提交已打分但没发布
    const row = (await view(b, "submissions")).find((r) => r.status !== undefined)!;
    expect(row).toMatchObject({ status: "grading", raw_score: null, final_score: null });
    const a = await authzOf(stu["stu.a"].token); // stu.a 的已发布
    expect((await view(a, "submissions"))[0]).toMatchObject({ status: "published", final_score: expect.anything() });
    // 老师看到未发布的分数
    const teacherRows = await view(await authzOf(users.cross.token), "submissions");
    expect(teacherRows.some((r) => r.status === "grading" && r.final_score !== null)).toBe(true);
  });

  describe("isolation and tampering", () => {
    it("another tenant's identity, even with the all-data scope, sees none of this tenant's rows", async () => {
      const other = await h.extraTenant();
      const o = await mkUser("other.reg", { roles: ["academic-manager"], person: "staff", tenant: other });
      const authz = await (await h.call(o.token, `${other.code}.localhost`).post("/api/internal/authz").set("x-internal-key", KEY)).body;
      for (const name of ["students", "sections", "enrollments", "assignments", "submissions", "final_grades"]) expect(await view(authz, name)).toEqual([]);
      const campuses = ids(await view(authz, "campuses"), "campus_id"); // 它自己的校区看得到，这个租户的一个都不行
      expect(campuses.length).toBeGreaterThan(0);
      expect(campuses).not.toContain(hqCampus);
      expect(campuses).not.toContain(shCampus);
      // 即便把本租户的范围（全部）原样用到别的租户 id 上，也还是只看得到别的租户（这里为空）的行
      const mine = await authzOf(users.reg.token);
      expect(await view({ ...mine, tenantId: other.tenantId }, "sections")).toEqual([]);
    });

    it("without an identity there are no rows; a scope for another permission does not widen this one", async () => {
      for (const name of ["campuses", "students", "sections", "enrollments", "assignments", "submissions", "final_grades"]) expect(await view(null, name)).toEqual([]);
      const lead = await authzOf(users.lead.token);
      const widened = { ...lead, scopes: { "hr:student:list": { all: true, deptIds: [], classIds: [], selfPersonId: null } } } as Authz;
      expect((await view(widened, "students")).length).toBe(4);
      expect(await view(widened, "sections")).toEqual([]); // 班级权限没有范围：不会因为学生权限是"全部"而放行
    });

    it("a query cannot rewrite its own identity settings or read the business tables", async () => {
      const authz = await authzOf(users.lead.token);
      await expect(
        reader.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.tenant_id', ${authz.tenantId}, true)`;
          await tx.$executeRawUnsafe("SET LOCAL ROLE ai_sql_ro");
          await tx.$queryRawUnsafe(`SELECT set_config('app.scopes', '{"hr:student:list":{"all":true}}', true)`);
        }),
      ).rejects.toThrow(/permission denied/);
      for (const table of ["biz.person", "biz.account", "biz.student_profile", "biz.final_grade", "biz.emergency_contact"]) {
        await expect(
          reader.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT set_config('app.tenant_id', ${authz.tenantId}, true)`;
            await tx.$executeRawUnsafe("SET LOCAL ROLE ai_sql_ro");
            await tx.$queryRawUnsafe(`SELECT * FROM ${table}`);
          }),
        ).rejects.toThrow(/permission denied/);
      }
    });

    it("the view columns carry no sensitive data (no e-mail, phone, ID number, address, login data)", async () => {
      const cols = await h.owner.$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'ai_sql'`);
      expect(cols.length).toBeGreaterThan(30);
      expect(cols.filter((c) => /mail|phone|mobile|id_?number|address|birth|password|token|keycloak|emergency/i.test(c.column_name))).toEqual([]);
    });
  });
});
