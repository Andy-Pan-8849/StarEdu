// 教学：目录规则、选课（自助与教务代选）、并发、退课、取消、课件、培养方案、数据范围。
import { Harness, type TestUser } from "../helpers/app";

const iso = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

describe("teaching: catalog, enrollment, materials, plan", () => {
  const h = new Harness();
  let boss: string;
  let reg: string;
  let regUser: TestUser;
  let hqDept: string;
  let hqCampus: string;
  let termId: string;
  let cs101: string;
  let cs102: string;
  let major: string;
  let teacher1: TestUser;
  let teacher2: TestUser;
  let t1: string;
  let t2: string;
  const admin = () => h.call(boss);
  const registrar = () => h.call(reg);

  async function student(name: string, opts: { status?: "enrolled" | "on_leave" } = {}) {
    const u = await h.user(name, { roles: ["student"], person: "student", studentStatus: opts.status });
    return { u, token: await u.token(), call: () => h.call(null) };
  }

  async function mkSection(courseId: string, number: string, over: Record<string, unknown> = {}, open = true) {
    const created = await registrar().post("/api/sections", { courseId, termId, campusId: hqCampus, number, capacity: 5, schedule: [], ...over });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    if (open) {
      expect((await registrar().put(`/api/sections/${id}/instructors`, { items: [{ personId: teacher1.personId, role: "lead" }] })).status).toBe(200);
      expect((await registrar().post(`/api/sections/${id}/status`, { status: "open" })).status).toBe(201);
    }
    return id;
  }

  beforeAll(async () => {
    await h.start();
    boss = await (await h.user("boss", { roles: ["tenant-admin"], person: "staff" })).token();
    const campus = await h.owner.campus.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, type: "hq" } });
    hqDept = campus.deptId;
    hqCampus = campus.id;
    regUser = await h.user("registrar", { roles: ["academic-manager"], person: "staff", deptIds: [hqDept] });
    reg = await regUser.token();
    teacher1 = await h.user("teacher.one", { roles: ["teacher"], person: "staff", deptIds: [hqDept] });
    teacher2 = await h.user("teacher.two", { roles: ["teacher"], person: "staff", deptIds: [hqDept] });
    t1 = await teacher1.token();
    t2 = await teacher2.token();
    termId = (await registrar().post("/api/terms", { code: "2026F", name: "2026 Fall", startDate: iso(-10), endDate: iso(80), enrollOpenDate: iso(-5), enrollCloseDate: iso(10), dropDeadline: iso(20) })).body.id;
    await registrar().post(`/api/terms/${termId}/status`, { status: "enrolling" });
    cs101 = (await registrar().post("/api/courses", { code: "CS101", name: "Intro", credits: 3 })).body.id;
    cs102 = (await registrar().post("/api/courses", { code: "CS102", name: "Next", credits: 4 })).body.id;
    major = (await registrar().post("/api/majors", { code: "CS", name: "Computer Science", totalCredits: 7, degreeType: "bachelor" })).body.id;
  });
  afterAll(() => h.stop());

  describe("catalog rules", () => {
    it("validates terms and follows the status machine", async () => {
      expect((await registrar().post("/api/terms", { code: "BAD", name: "Bad", startDate: iso(10), endDate: iso(1) })).status).toBe(400);
      expect((await registrar().post("/api/terms", { code: "BAD2", name: "Bad", startDate: iso(0), endDate: iso(50), dropDeadline: iso(99) })).status).toBe(400);
      expect((await registrar().post("/api/terms", { code: "2026F", name: "Dup", startDate: iso(0), endDate: iso(50) })).status).toBe(409);
      expect((await registrar().post(`/api/terms/${termId}/status`, { status: "ended" })).status).toBe(409); // 不能跳过"进行中"
      expect((await registrar().patch(`/api/terms/${termId}`, { code: "X" })).status).toBe(400); // 学期代码不能改
    });

    it("prerequisites cannot form a cycle or point at themselves", async () => {
      expect((await registrar().put(`/api/courses/${cs102}/prerequisites`, { courseIds: [cs101] })).status).toBe(200);
      expect((await registrar().put(`/api/courses/${cs101}/prerequisites`, { courseIds: [cs102] })).status).toBe(400); // 成环
      expect((await registrar().put(`/api/courses/${cs101}/prerequisites`, { courseIds: [cs101] })).status).toBe(400);
      const detail = (await registrar().get(`/api/courses/${cs102}`)).body;
      expect(detail.prerequisites.map((p: { code: string }) => p.code)).toEqual(["CS101"]);
    });

    it("curriculum: category belongs to the major-course relation; a course appears once", async () => {
      expect((await registrar().put(`/api/majors/${major}/courses`, { items: [{ courseId: cs101, category: "required", suggestedTerm: 1 }, { courseId: cs102, category: "elective", suggestedTerm: 2 }] })).status).toBe(200);
      expect((await registrar().put(`/api/majors/${major}/courses`, { items: [{ courseId: cs101, category: "required" }, { courseId: cs101, category: "elective" }] })).status).toBe(400);
      expect((await registrar().put(`/api/majors/${major}/courses`, { items: [{ courseId: cs101, category: "required", suggestedTerm: 1 }, { courseId: cs102, category: "elective", suggestedTerm: 2 }] })).status).toBe(200);
      expect((await registrar().get(`/api/courses/${cs101}`)).body.majors).toEqual([expect.objectContaining({ code: "CS", category: "required" })]);
    });

    it("once a course has sections, its code and credits are read-only", async () => {
      const spare = (await registrar().post("/api/courses", { code: "SP100", name: "Spare", credits: 2 })).body.id;
      expect((await registrar().patch(`/api/courses/${spare}`, { credits: 3 })).status).toBe(200); // 还没有班级
      await mkSection(spare, "01", {}, false);
      expect((await registrar().patch(`/api/courses/${spare}`, { credits: 4 })).status).toBe(409);
      expect((await registrar().patch(`/api/courses/${spare}`, { code: "SP101" })).status).toBe(409);
      expect((await registrar().patch(`/api/courses/${spare}`, { name: "Renamed", status: false })).status).toBe(200); // 名称、状态仍可改
      expect((await registrar().post("/api/sections", { courseId: spare, termId, campusId: hqCampus, number: "02", capacity: 5 })).status).toBe(409); // 停用的课程不能再开班
    });
  });

  describe("sections, instructors and permissions", () => {
    let sec: string;
    it("a section needs an instructor to open; an instructor cannot also be a student there; instructors must be active staff", async () => {
      sec = await mkSection(cs101, "01", { schedule: [{ weekday: 1, start: "09:00", end: "10:30" }] }, false);
      expect((await registrar().post(`/api/sections/${sec}/status`, { status: "open" })).status).toBe(409);
      expect((await registrar().put(`/api/sections/${sec}/instructors`, { items: [{ personId: teacher1.personId, role: "lead" }, { personId: teacher2.personId, role: "assistant" }] })).status).toBe(200);
      expect((await registrar().put(`/api/sections/${sec}/instructors`, { items: [{ personId: "11111111-1111-4111-8111-111111111111", role: "lead" }] })).status).toBe(400);
      const stu = await student("s.instructor");
      expect((await registrar().put(`/api/sections/${sec}/instructors`, { items: [{ personId: stu.u.personId, role: "lead" }] })).status).toBe(409); // 学生不是教职员工
      await registrar().put(`/api/sections/${sec}/instructors`, { items: [{ personId: teacher1.personId, role: "lead" }] });
      expect((await registrar().post(`/api/sections/${sec}/status`, { status: "open" })).status).toBe(201);
    });

    it("the same person cannot be both instructor and student in a section (service and database trigger)", async () => {
      // 老师本人也有学员档案：选他自己任教的班 → 409；再把已选课的学生指为老师 → 409
      const dual = await h.user("dual.person", { roles: ["student"], person: "staff" });
      await h.owner.studentProfile.create({ data: { tenantId: h.tenant.tenantId, personId: dual.personId as string, studentNo: "S-dual", campusId: hqCampus } });
      await registrar().put(`/api/sections/${sec}/instructors`, { items: [{ personId: teacher1.personId, role: "lead" }, { personId: dual.personId, role: "assistant" }] });
      const res = await h.call(await dual.token()).post("/api/portal/enrollments", { sectionId: sec });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("INSTRUCTOR");
      await registrar().put(`/api/sections/${sec}/instructors`, { items: [{ personId: teacher1.personId, role: "lead" }] });
      const other = await mkSection(cs102, "01", {}, false);
      await h.owner.enrollment.create({ data: { tenantId: h.tenant.tenantId, sectionId: other, studentPersonId: dual.personId as string } });
      expect((await registrar().put(`/api/sections/${other}/instructors`, { items: [{ personId: dual.personId, role: "lead" }] })).status).toBe(409);
      await expect(h.owner.sectionInstructor.create({ data: { tenantId: h.tenant.tenantId, sectionId: other, personId: dual.personId as string } })).rejects.toThrow(/both instructor and student/); // 触发器兜底
    });

    it("teachers see only their own sections and cannot change a section's structure; the tenant administrator sees none", async () => {
      expect(((await h.call(t1).get("/api/sections")).body as Array<{ id: string }>).map((s) => s.id)).toContain(sec);
      expect(((await h.call(t2).get("/api/sections")).body as Array<{ id: string }>).map((s) => s.id)).not.toContain(sec);
      expect((await h.call(t2).get(`/api/sections/${sec}`)).status).toBe(404);
      expect((await h.call(t1).patch(`/api/sections/${sec}`, { capacity: 99 })).status).toBe(403); // 教师没有改结构的权限
      expect((await h.call(t1).post(`/api/sections/${sec}/status`, { status: "cancelled" })).status).toBe(403);
      expect((await admin().get("/api/sections")).body).toEqual([]);
      expect((await admin().get(`/api/sections/${sec}`)).status).toBe(404);
      expect((await registrar().patch(`/api/sections/${sec}`, { capacity: 6 })).status).toBe(200);
    });
  });

  describe("self-service enrollment rules", () => {
    it("enrolls a student in an open section; refuses duplicates, drafts, students who are not 'enrolled', and full sections", async () => {
      const a = await student("e.one");
      const sec = await mkSection(cs101, "10", { capacity: 1 });
      const draft = await mkSection(cs101, "11", {}, false);
      expect((await h.call(a.token).post("/api/portal/enrollments", { sectionId: draft })).body.code).toBe("SECTION_NOT_OPEN");
      expect((await h.call(a.token).post("/api/portal/enrollments", { sectionId: sec })).status).toBe(201);
      const again = await h.call(a.token).post("/api/portal/enrollments", { sectionId: sec });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("DUPLICATE");
      const full = await student("e.two");
      const refused = await h.call(full.token).post("/api/portal/enrollments", { sectionId: sec });
      expect(refused.status).toBe(409);
      expect(refused.body.violations).toEqual(["capacity"]);
      const onLeave = await student("e.leave", { status: "on_leave" });
      expect((await h.call(onLeave.token).post("/api/portal/enrollments", { sectionId: await mkSection(cs101, "12") })).body.code).toBe("NOT_ENROLLED");
    });

    it("prerequisites must be passed; a registrar-recorded pass unlocks the next course", async () => {
      const a = await student("p.one");
      const sec = await mkSection(cs102, "10");
      const blocked = await h.call(a.token).post("/api/portal/enrollments", { sectionId: sec });
      expect(blocked.status).toBe(409);
      expect(blocked.body.violations).toEqual(["prerequisite"]);
      expect(blocked.body.detail.prerequisite).toEqual(["CS101"]);
      // 通过 CS101（成绩模块 B8 才会写；这里直接写）
      const old = await mkSection(cs101, "13", {}, false);
      await h.owner.enrollment.create({ data: { tenantId: h.tenant.tenantId, sectionId: old, studentPersonId: a.u.personId as string, status: "completed", passed: true } });
      expect((await h.call(a.token).post("/api/portal/enrollments", { sectionId: sec })).status).toBe(201);
    });

    it("outside the enrollment window is refused; a schedule clash only warns", async () => {
      const a = await student("w.one");
      const late = (await registrar().post("/api/terms", { code: "LATE", name: "Closed window", startDate: iso(-30), endDate: iso(60), enrollOpenDate: iso(-20), enrollCloseDate: iso(-2), dropDeadline: iso(10) })).body.id;
      const lateCourse = (await registrar().post("/api/courses", { code: "LT100", name: "Late", credits: 1 })).body.id;
      const lateSec = (await registrar().post("/api/sections", { courseId: lateCourse, termId: late, campusId: hqCampus, number: "01", capacity: 5 })).body.id;
      await registrar().put(`/api/sections/${lateSec}/instructors`, { items: [{ personId: teacher1.personId, role: "lead" }] });
      await registrar().post(`/api/sections/${lateSec}/status`, { status: "open" });
      await registrar().post(`/api/terms/${late}/status`, { status: "enrolling" });
      expect((await h.call(a.token).post("/api/portal/enrollments", { sectionId: lateSec })).body.violations).toEqual(["window"]);

      const clash1 = await mkSection(cs101, "20", { schedule: [{ weekday: 2, start: "10:00", end: "11:30" }] });
      const spare = (await registrar().post("/api/courses", { code: "CL200", name: "Clash", credits: 1 })).body.id;
      const clash2 = await mkSection(spare, "01", { schedule: [{ weekday: 2, start: "11:00", end: "12:00" }] });
      expect((await h.call(a.token).post("/api/portal/enrollments", { sectionId: clash1 })).body.conflicts).toEqual([]);
      const second = await h.call(a.token).post("/api/portal/enrollments", { sectionId: clash2 });
      expect(second.status).toBe(201); // 只提示不阻止
      expect(second.body.conflicts).toEqual([expect.objectContaining({ name: expect.stringContaining("CS101-20") })]);
      // 门户的开放班级列表：已选的班只和"别的"班冲突，不会提示和自己冲突
      const listed = (await h.call(a.token).get("/api/portal/sections")).body.sections as Array<{ id: string; name: string; conflicts: string[] }>;
      const own = listed.find((s) => s.id === clash1)!;
      expect(own.conflicts).toHaveLength(1);
      expect(own.conflicts).not.toContain(own.name);
      expect(own.conflicts[0]).toContain("CL200");
    });

    it("the portal lists open sections with my requirement, missing prerequisites and clashes; no major means no label", async () => {
      const a = await student("l.one");
      const first = (await h.call(a.token).get("/api/portal/sections")).body;
      expect(first.declaredMajor).toBeNull();
      expect(first.sections.every((s: { requirement: unknown }) => s.requirement === null)).toBe(true);
      expect((await registrar().put(`/api/majors/${major}/students/${a.u.personId}`, { kind: "primary" })).status).toBe(200);
      const mine = (await h.call(a.token).get("/api/portal/sections?filter=mine")).body;
      expect(mine.declaredMajor.name).toBe("Computer Science");
      const cs = mine.sections.filter((s: { course: { code: string } }) => s.course.code === "CS102");
      expect(cs.length).toBeGreaterThan(0);
      expect(cs[0]).toMatchObject({ requirement: "elective", prerequisitesMet: false, missingPrerequisites: ["CS101"] });
      expect(mine.sections.every((s: { course: { code: string } }) => ["CS101", "CS102"].includes(s.course.code))).toBe(true); // 只列我专业里的
    });

    it("a student can open the details of an open section, and of a class they took; other classes are 404", async () => {
      const a = await student("detail.one");
      const open = (await h.call(a.token).get("/api/portal/sections")).body.sections as Array<{ id: string; course: { code: string } }>;
      const target = open.find((s) => s.course.code === "CS102")!;
      const d = await h.call(a.token).get(`/api/portal/sections/${target.id}`);
      expect(d.status).toBe(200);
      expect(d.body).toMatchObject({ id: target.id, course: { code: "CS102", credits: expect.any(Number) }, prerequisites: [expect.objectContaining({ code: "CS101", met: false })], myEnrollment: null });
      expect(d.body.seatsLeft).toBeGreaterThanOrEqual(0);
      // 选了之后详情里能看到"我的选课"
      const first = open.find((s) => s.course.code === "CS101")!;
      expect((await h.call(a.token).post("/api/portal/enrollments", { sectionId: first.id })).status).toBe(201);
      expect((await h.call(a.token).get(`/api/portal/sections/${first.id}`)).body.myEnrollment).toMatchObject({ status: "enrolled" });
      // 草稿班（没开放、也不是我的）和不存在的 id 看不到
      const draft = (await registrar().post("/api/sections", { courseId: cs101, termId, campusId: hqCampus, number: "97", capacity: 5 })).body.id;
      expect((await h.call(a.token).get(`/api/portal/sections/${draft}`)).status).toBe(404);
      expect((await h.call(a.token).get("/api/portal/sections/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    });
  });

  describe("concurrency", () => {
    it("many simultaneous requests for the last seat: exactly one succeeds and the class is never oversold", async () => {
      const sec = await mkSection(cs101, "30", { capacity: 1 });
      const students = [];
      for (let i = 0; i < 6; i += 1) students.push(await student(`race.${i}`));
      const results = await Promise.all(students.map((s) => h.call(s.token).post("/api/portal/enrollments", { sectionId: sec })));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(5);
      expect(results.filter((r) => r.status === 409).every((r) => r.body.violations?.[0] === "capacity" || r.body.code === "DUPLICATE")).toBe(true);
      expect(await h.owner.enrollment.count({ where: { sectionId: sec, status: "enrolled" } })).toBe(1);
    });

    it("the same student clicking twice at once gets one enrollment", async () => {
      const sec = await mkSection(cs102, "31", { capacity: 5 });
      const a = await student("twice");
      const old = await mkSection(cs101, "32", {}, false);
      await h.owner.enrollment.create({ data: { tenantId: h.tenant.tenantId, sectionId: old, studentPersonId: a.u.personId as string, status: "completed", passed: true } });
      const [r1, r2] = await Promise.all([h.call(a.token).post("/api/portal/enrollments", { sectionId: sec }), h.call(a.token).post("/api/portal/enrollments", { sectionId: sec })]);
      expect([r1.status, r2.status].sort()).toEqual([201, 409]);
      expect(await h.owner.enrollment.count({ where: { sectionId: sec, studentPersonId: a.u.personId as string, status: "enrolled" } })).toBe(1);
    });
  });

  describe("dropping", () => {
    it("before the deadline the record is voided and disappears; after it the record becomes W and stays; nobody can drop someone else's", async () => {
      const a = await student("d.one");
      const b = await student("d.two");
      const sec = await mkSection(cs101, "40");
      const ea = (await h.call(a.token).post("/api/portal/enrollments", { sectionId: sec })).body.enrollmentId;
      const eb = (await h.call(b.token).post("/api/portal/enrollments", { sectionId: sec })).body.enrollmentId;
      expect((await h.call(a.token).del(`/api/portal/enrollments/${eb}`)).status).toBe(404); // 别人的
      expect((await h.call(a.token).del(`/api/portal/enrollments/${ea}`)).body.status).toBe("voided");
      expect(((await h.call(a.token).get("/api/portal/my-enrollments")).body as Array<{ id: string }>).map((e) => e.id)).not.toContain(ea); // 作废的不出现
      expect((await h.call(a.token).del(`/api/portal/enrollments/${ea}`)).status).toBe(409);
      // 退课截止日已过
      await h.owner.term.update({ where: { id: termId }, data: { dropDeadline: new Date(iso(-1)) } });
      try {
        const dropped = await h.call(b.token).del(`/api/portal/enrollments/${eb}`);
        expect(dropped.body.status).toBe("withdrawn");
        const mine = (await h.call(b.token).get("/api/portal/my-enrollments")).body as Array<{ id: string; status: string }>;
        expect(mine.find((e) => e.id === eb)?.status).toBe("withdrawn"); // W 保留
      } finally {
        await h.owner.term.update({ where: { id: termId }, data: { dropDeadline: new Date(iso(20)) } });
      }
    });
  });

  describe("registrar enrollment", () => {
    let full: string;
    beforeAll(async () => {
      full = await mkSection(cs101, "50", { capacity: 1 });
      const first = await student("r.first");
      expect((await h.call(first.token).post("/api/portal/enrollments", { sectionId: full })).status).toBe(201);
    });

    it("hard blocks cannot be confirmed away; confirmable situations need the confirmation list and a reason", async () => {
      const s = await student("r.second");
      const unconfirmed = await registrar().post(`/api/sections/${full}/enrollments`, { studentIds: [s.u.personId] });
      expect(unconfirmed.body.results[0]).toMatchObject({ ok: false, code: "CONFIRMATION_REQUIRED", violations: ["capacity"] });
      const noReason = await registrar().post(`/api/sections/${full}/enrollments`, { studentIds: [s.u.personId], confirm: ["capacity"] });
      expect(noReason.body.results[0].ok).toBe(false);
      const ok = await registrar().post(`/api/sections/${full}/enrollments`, { studentIds: [s.u.personId], confirm: ["capacity"], reason: "Special approval from the director" });
      expect(ok.body.results[0].ok).toBe(true);
      const row = await h.owner.enrollment.findFirstOrThrow({ where: { sectionId: full, studentPersonId: s.u.personId as string } });
      expect(row).toMatchObject({ method: "registrar", reason: "Special approval from the director", overrides: ["capacity"], status: "enrolled" });
      // 超员后名单里就是 2/1
      expect((await registrar().get(`/api/sections/${full}/roster`)).body).toHaveLength(2);

      const onLeave = await student("r.leave", { status: "on_leave" });
      const hard = await registrar().post(`/api/sections/${full}/enrollments`, { studentIds: [onLeave.u.personId], confirm: ["capacity", "prerequisite", "window", "conflict", "retake"], reason: "please" });
      expect(hard.body.results[0]).toMatchObject({ ok: false, code: "NOT_ENROLLED" });
      const dup = await registrar().post(`/api/sections/${full}/enrollments`, { studentIds: [s.u.personId], confirm: ["capacity"], reason: "again" });
      expect(dup.body.results[0]).toMatchObject({ ok: false, code: "DUPLICATE" });
    });

    it("the action is logged, queued for notification, and removal follows the drop rules; teachers and other campuses are refused", async () => {
      const s = await student("r.third");
      const sec = await mkSection(cs102, "51");
      const old = await mkSection(cs101, "52", {}, false);
      await h.owner.enrollment.create({ data: { tenantId: h.tenant.tenantId, sectionId: old, studentPersonId: s.u.personId as string, status: "completed", passed: true } });
      const added = await registrar().post(`/api/sections/${sec}/enrollments`, { studentIds: [s.u.personId] });
      expect(added.body.results[0].ok).toBe(true);
      expect(await h.owner.outboxEvent.count({ where: { tenantId: h.tenant.tenantId, type: "enrollment.registrar_added" } })).toBeGreaterThan(0);
      const audit = (await admin().get("/api/audit-logs?size=100")).body as Array<{ action: string; targetId: string }>;
      expect(audit.some((a) => a.action === "enrollment.add" && a.targetId === sec)).toBe(true);
      expect((await h.call(t1).post(`/api/sections/${sec}/enrollments`, { studentIds: [s.u.personId] })).status).toBe(403); // 教师不能代选
      const removed = await registrar().del(`/api/sections/${sec}/enrollments/${added.body.results[0].enrollmentId}`);
      expect(removed.body.status).toBe("voided");
      expect(await h.owner.outboxEvent.count({ where: { tenantId: h.tenant.tenantId, type: "enrollment.registrar_removed" } })).toBeGreaterThan(0);

      // 只管总部校区的教务：另一个校区的班不在范围内
      const sh = (await admin().post("/api/campuses", { code: "SH", name: "Shanghai" })).body;
      const shSec = (await registrar().post("/api/sections", { courseId: cs101, termId, campusId: sh.id, number: "90", capacity: 5 })).body.id;
      expect(shSec).toBeDefined();
      const scoped = await h.user("hq.registrar", { roles: ["academic-manager"], person: "staff", deptIds: [hqDept] });
      await h.owner.dataScopeSet.findFirstOrThrow({ where: { code: "own_dept" } }); // 内置集存在
      const roleId = (await h.owner.role.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, code: "academic-manager" } })).id;
      const ownTree = await h.owner.dataScopeSet.findFirstOrThrow({ where: { code: "own_dept" } });
      await h.owner.roleDataScope.deleteMany({ where: { roleId } });
      await h.owner.roleDataScope.create({ data: { tenantId: h.tenant.tenantId, roleId, setId: ownTree.id } });
      await h.bump();
      try {
        const st = await h.call(await scoped.token());
        expect((await st.get(`/api/sections/${shSec}`)).status).toBe(404);
      } finally {
        const all = await h.owner.dataScopeSet.findFirstOrThrow({ where: { code: "all" } });
        await h.owner.roleDataScope.deleteMany({ where: { roleId } });
        await h.owner.roleDataScope.create({ data: { tenantId: h.tenant.tenantId, roleId, setId: all.id } });
        await h.bump();
      }
    });
  });

  describe("cancelling and ending", () => {
    it("cancelling a section voids the enrolled records and queues a notification per student", async () => {
      const sec = await mkSection(cs101, "60");
      const a = await student("c.one");
      const b = await student("c.two");
      await h.call(a.token).post("/api/portal/enrollments", { sectionId: sec });
      await h.call(b.token).post("/api/portal/enrollments", { sectionId: sec });
      const res = await registrar().post(`/api/sections/${sec}/status`, { status: "cancelled" });
      expect(res.body).toMatchObject({ status: "cancelled", voidedEnrollments: 2 });
      expect(await h.owner.enrollment.count({ where: { sectionId: sec, status: "voided" } })).toBe(2);
      const events = await h.owner.outboxEvent.findMany({ where: { tenantId: h.tenant.tenantId, type: "section.cancelled" } });
      expect(events.filter((e) => (e.payload as { sectionId: string }).sectionId === sec)).toHaveLength(2);
      expect((await h.call(a.token).post("/api/portal/enrollments", { sectionId: sec })).body.code).toBe("SECTION_NOT_OPEN");
      expect((await registrar().post(`/api/sections/${sec}/status`, { status: "open" })).status).toBe(409);
    });

    it("ending the term ends its sections and completes the enrolled records", async () => {
      const t = (await registrar().post("/api/terms", { code: "END1", name: "To end", startDate: iso(-60), endDate: iso(-1), enrollOpenDate: iso(-70), enrollCloseDate: iso(-50), dropDeadline: iso(-40) })).body.id;
      const course = (await registrar().post("/api/courses", { code: "EN100", name: "Ending", credits: 2 })).body.id;
      const sec = (await registrar().post("/api/sections", { courseId: course, termId: t, campusId: hqCampus, number: "01", capacity: 5 })).body.id;
      await registrar().put(`/api/sections/${sec}/instructors`, { items: [{ personId: teacher1.personId, role: "lead" }] });
      await registrar().post(`/api/sections/${sec}/status`, { status: "open" });
      await registrar().post(`/api/terms/${t}/status`, { status: "enrolling" });
      const a = await student("end.one");
      await registrar().post(`/api/sections/${sec}/enrollments`, { studentIds: [a.u.personId], confirm: ["window"], reason: "late approval" });
      await registrar().post(`/api/terms/${t}/status`, { status: "in_progress" });
      expect((await registrar().post(`/api/terms/${t}/status`, { status: "ended" })).body.status).toBe("ended");
      expect((await h.owner.section.findUniqueOrThrow({ where: { id: sec } })).status).toBe("ended");
      expect(await h.owner.enrollment.count({ where: { sectionId: sec, status: "completed" } })).toBe(1);
      // 结束后不能退课、不能改学期
      const e = await h.owner.enrollment.findFirstOrThrow({ where: { sectionId: sec } });
      expect((await h.call(a.token).del(`/api/portal/enrollments/${e.id}`)).status).toBe(409);
      expect((await registrar().patch(`/api/terms/${t}`, { name: "x" })).status).toBe(409);
    });
  });

  describe("course materials", () => {
    it("instructors manage them; students see only published ones while enrolled; dropping loses access; after the end they stay read-only", async () => {
      const sec = await mkSection(cs101, "70");
      const a = await student("m.one");
      const enrolled = (await h.call(a.token).post("/api/portal/enrollments", { sectionId: sec })).body.enrollmentId;
      const draft = await h.call(t1).post(`/api/sections/${sec}/materials`, { title: "Draft notes", url: "https://example.test/draft", published: false });
      expect(draft.status).toBe(201);
      await h.call(t1).post(`/api/sections/${sec}/materials`, { title: "Week 1", url: "https://example.test/w1", published: true, category: "slides" });
      expect((await h.call(t2).post(`/api/sections/${sec}/materials`, { title: "x", url: "https://example.test/x" })).status).toBe(404); // 别班的老师：看不到这个班
      expect((await registrar().post(`/api/sections/${sec}/materials`, { title: "x", url: "https://example.test/x" })).status).toBe(403); // 教务可看不可改
      expect((await h.call(t1).post(`/api/sections/${sec}/materials`, { title: "bad", url: "not a url" })).status).toBe(400);
      expect(((await h.call(t1).get(`/api/sections/${sec}/materials`)).body as unknown[]).length).toBe(2);
      expect(((await registrar().get(`/api/sections/${sec}/materials`)).body as unknown[]).length).toBe(2);
      expect(((await h.call(a.token).get(`/api/portal/sections/${sec}/materials`)).body as Array<{ title: string }>).map((m) => m.title)).toEqual(["Week 1"]);
      expect((await h.call(t1).patch(`/api/sections/${sec}/materials/${draft.body.id}`, { published: true })).status).toBe(200);
      expect(((await h.call(a.token).get(`/api/portal/sections/${sec}/materials`)).body as unknown[]).length).toBe(2);

      const stranger = await student("m.two");
      expect((await h.call(stranger.token).get(`/api/portal/sections/${sec}/materials`)).status).toBe(404);
      await h.call(a.token).del(`/api/portal/enrollments/${enrolled}`);
      expect((await h.call(a.token).get(`/api/portal/sections/${sec}/materials`)).status).toBe(404); // 退课失去访问

      const b = await student("m.three");
      await h.call(b.token).post("/api/portal/enrollments", { sectionId: sec });
      await registrar().post(`/api/sections/${sec}/status`, { status: "in_progress" });
      await registrar().post(`/api/sections/${sec}/status`, { status: "ended" });
      expect(((await h.call(b.token).get(`/api/portal/sections/${sec}/materials`)).body as unknown[]).length).toBe(2); // 结课后保留只读
      expect((await h.call(t1).post(`/api/sections/${sec}/materials`, { title: "late", url: "https://example.test/late" })).status).toBe(409);
      expect((await h.call(t1).del(`/api/sections/${sec}/materials/${draft.body.id}`)).status).toBe(409);
    });
  });

  describe("degree plan", () => {
    it("shows each course of my major as passed, in progress or not taken, and counts only passed credits", async () => {
      const a = await student("plan.one");
      expect((await h.call(a.token).get("/api/portal/plan")).body.declaredMajor).toBeNull();
      await registrar().put(`/api/majors/${major}/students/${a.u.personId}`, { kind: "primary" });
      const sec = await mkSection(cs101, "80");
      await h.call(a.token).post("/api/portal/enrollments", { sectionId: sec });
      let plan = (await h.call(a.token).get("/api/portal/plan")).body;
      expect(plan.courses.map((c: { code: string; state: string }) => [c.code, c.state])).toEqual([["CS101", "in_progress"], ["CS102", "not_taken"]]);
      expect(plan.credits).toEqual({ earned: 0, required: 7 }); // 进行中的不算
      await h.owner.enrollment.updateMany({ where: { sectionId: sec, studentPersonId: a.u.personId as string }, data: { status: "completed", passed: true } });
      plan = (await h.call(a.token).get("/api/portal/plan")).body;
      expect(plan.courses[0].state).toBe("passed");
      expect(plan.credits).toEqual({ earned: 3, required: 7 });
      expect(plan.courses[0]).toMatchObject({ category: "required", suggestedTerm: 1 });
    });
  });

  describe("class dimension of the data scope", () => {
    it("the 'classes I teach or attend' scope resolves for teachers and students", async () => {
      const a = await student("scope.one");
      const sec = await mkSection(cs101, "85");
      await h.call(a.token).post("/api/portal/enrollments", { sectionId: sec });
      const { CLASS_MEMBERSHIP } = await import("../../src/data-scope/data-scope.service");
      const provider = h.app.get(CLASS_MEMBERSHIP);
      const { runInScope } = await import("../../src/tenancy/request-scope");
      const scope = { kind: "tenant" as const, tenantId: h.tenant.tenantId, code: h.tenant.code, name: "t", status: "active" };
      expect(await runInScope(scope, () => provider.classIdsFor(a.u.personId as string))).toContain(sec);
      expect(await runInScope(scope, () => provider.classIdsFor(teacher1.personId as string))).toContain(sec);
      expect(await runInScope(scope, () => provider.classIdsFor(teacher2.personId as string))).not.toContain(sec);
    });
  });

  describe("back-fills from earlier milestones", () => {
    it("staff who still teach are warned before ending employment; the campus closing check counts running sections", async () => {
      // 带班教师离职提示、关闭校区检查里的"进行中的班级"
      const sh = (await admin().post("/api/campuses", { code: "GZ", name: "Guangzhou" })).body;
      const gzDept = sh.deptId;
      const sec = (await registrar().post("/api/sections", { courseId: cs101, termId, campusId: sh.id, number: "95", capacity: 5 })).body.id;
      await admin().post(`/api/campuses/${sh.id}/status`, { status: "stop_new" });
      const check = (await admin().get(`/api/campuses/${sh.id}/closure-check`)).body;
      expect(check.classes).toMatchObject({ implemented: true, count: 1 });
      expect(check.canClose).toBe(false);
      await registrar().post(`/api/sections/${sec}/status`, { status: "cancelled" });
      expect((await admin().get(`/api/campuses/${sh.id}/closure-check`)).body.canClose).toBe(true);
      void gzDept;

      // 带班教师离职：保存前提示仍带的班级，不阻止
      const teaching = await mkSection(cs101, "96", {});
      const hrm = await h.user("hr.manager", { roles: ["hr-manager"], person: "staff" });
      const ended = await h.call(await hrm.token()).post(`/api/staff/${teacher1.personId}/end`, { status: "on_leave" });
      expect(ended.status).toBe(201);
      expect(ended.body.warnings.some((w: string) => w.includes("Still teaching"))).toBe(true);
      expect(await h.owner.section.count({ where: { id: teaching } })).toBe(1);
      await h.call(await hrm.token()).post(`/api/staff/${teacher1.personId}/reinstate`);
    });
  });
});
