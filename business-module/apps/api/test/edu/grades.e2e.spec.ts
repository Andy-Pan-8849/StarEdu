// 成绩：成绩构成、成绩册、手工录分、总评、发布（写 passed）、结课后锁定与更正、等级表、GPA 与重修、成绩单 PDF、仪表板。
import { Harness, type TestUser } from "../helpers/app";

const iso = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

describe("grades: policy, grade book, final grades, transcripts, dashboard", () => {
  const h = new Harness();
  let boss: string;
  let reg: string;
  let t1: string;
  let t2: string;
  let teacher1: TestUser;
  let hqCampus: string;
  let hqDept: string;
  let termId: string;
  let sec: string;
  let hwGroup: string;
  let examGroup: string;
  let hw: string;
  let exam: string;
  const registrar = () => h.call(reg);
  const teacher = () => h.call(t1);
  const other = () => h.call(t2);
  const stu: Record<string, { u: TestUser; token: string }> = {};
  const as = (n: string) => h.call(stu[n].token);
  const pid = (n: string) => stu[n].u.personId as string;

  async function student(name: string) {
    const u = await h.user(name, { roles: ["student"], person: "student" });
    stu[name] = { u, token: await u.token() };
  }
  async function mkSection(courseId: string, number: string, students: string[], campusId = hqCampus, open = true) {
    const created = await registrar().post("/api/sections", { courseId, termId, campusId, number, capacity: 20, schedule: [] });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect((await registrar().put(`/api/sections/${id}/instructors`, { items: [{ personId: teacher1.personId, role: "lead" }] })).status).toBe(200);
    if (open) expect((await registrar().post(`/api/sections/${id}/status`, { status: "open" })).status).toBe(201);
    if (students.length) expect((await registrar().post(`/api/sections/${id}/enrollments`, { studentIds: students.map(pid) })).body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    return id;
  }
  const book = async () => (await teacher().get(`/api/sections/${sec}/gradebook`)).body;
  const row = async (name: string) => (await book()).students.find((s: { fullName: string }) => s.fullName === name);

  /** 学生提交，教师按给定分数打分并发布。 */
  async function submitAndPublish(name: string, a: string, points: [number, number]) {
    expect((await as(name).post(`/api/portal/assignments/${a}/submissions`, { text: "answer" })).status).toBe(201);
    const sub = (await teacher().get(`/api/sections/${sec}/assignments/${a}/submissions`)).body.rows.find((r: { fullName: string }) => r.fullName === name).submissionId;
    const items = (await teacher().get(`/api/sections/${sec}/assignments/${a}`)).body.rubric;
    await teacher().put(`/api/sections/${sec}/assignments/${a}/submissions/${sub}/grade`, { scores: items.map((i: { id: string }, k: number) => ({ rubricItemId: i.id, points: points[k] })) });
    return sub as string;
  }

  beforeAll(async () => {
    await h.start();
    boss = await (await h.user("boss", { roles: ["tenant-admin"], person: "staff" })).token();
    const campus = await h.owner.campus.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, type: "hq" } });
    hqCampus = campus.id;
    hqDept = campus.deptId;
    reg = await (await h.user("registrar", { roles: ["academic-manager"], person: "staff", deptIds: [hqDept] })).token();
    teacher1 = await h.user("teacher.one", { roles: ["teacher"], person: "staff", deptIds: [hqDept] });
    t1 = await teacher1.token();
    t2 = await (await h.user("teacher.two", { roles: ["teacher"], person: "staff", deptIds: [hqDept] })).token();
    for (const n of ["st1", "st2", "st3", "st4"]) await student(n);
    termId = (await registrar().post("/api/terms", { code: "2026F", name: "2026 Fall", startDate: iso(-10), endDate: iso(80), enrollOpenDate: iso(-5), enrollCloseDate: iso(10), dropDeadline: iso(20) })).body.id;
    await registrar().post(`/api/terms/${termId}/status`, { status: "enrolling" });
    const cs301 = (await registrar().post("/api/courses", { code: "CS301", name: "Algorithms", credits: 4 })).body.id;
    sec = await mkSection(cs301, "01", ["st1", "st2", "st3"]);
    hwGroup = (await teacher().post(`/api/sections/${sec}/assignment-groups`, { name: "Homework" })).body.id;
    examGroup = (await teacher().post(`/api/sections/${sec}/assignment-groups`, { name: "Exam" })).body.id;
    const mk = async (body: object) => {
      const a = (await teacher().post(`/api/sections/${sec}/assignments`, { dueDate: iso(3), ...body })).body.id as string;
      await teacher().post(`/api/sections/${sec}/assignments/${a}/publish`, { published: true });
      return a;
    };
    hw = await mk({ title: "HW1", groupId: hwGroup, rubric: [{ title: "Correctness", maxPoints: 6 }, { title: "Style", maxPoints: 4 }] });
    exam = await mk({ title: "Final exam", groupId: examGroup, manualOnly: true, rubric: [{ title: "Exam", maxPoints: 100 }] });
  });
  afterAll(() => h.stop());

  describe("grade policy", () => {
    it("the weights must add up to exactly 100 before anything is calculated", async () => {
      expect((await book()).problems).toEqual(["Weights add up to 0%, not 100%"]);
      const put = (groups: object[]) => teacher().put(`/api/sections/${sec}/grade-policy`, { groups });
      expect((await put([{ id: hwGroup, weight: 40 }, { id: examGroup, weight: 50 }])).status).toBe(400);
      expect((await put([{ id: hwGroup, weight: 40 }, { id: "11111111-1111-4111-8111-111111111111", weight: 60 }])).status).toBe(400);
      expect((await put([{ id: hwGroup, weight: 40.123 }, { id: examGroup, weight: 59.877 }])).status).toBe(400); // 最多两位小数
      expect((await other().put(`/api/sections/${sec}/grade-policy`, { groups: [{ id: hwGroup, weight: 40 }, { id: examGroup, weight: 60 }] })).status).toBe(404); // 不教这个班
      expect((await registrar().put(`/api/sections/${sec}/grade-policy`, { groups: [{ id: hwGroup, weight: 40 }, { id: examGroup, weight: 60 }] })).status).toBe(403);
      const ok = await put([{ id: hwGroup, weight: 40 }, { id: examGroup, weight: 60 }]);
      expect(ok.status).toBe(200);
      expect(ok.body.weightTotal).toBe(100);
      expect((await book()).problems).toEqual([]);
    });

    it("an assignment in a group with weight 0 or without a group does not count", async () => {
      const book1 = await book();
      expect(book1.assignments.map((a: { title: string; counted: boolean }) => [a.title, a.counted])).toEqual([["HW1", true], ["Final exam", true]]);
    });
  });

  describe("grade book, manual scores and the total", () => {
    it("manual scores follow the rules: published assignment, enrolled student, not above the maximum, not over a published submission", async () => {
      const path = (a: string, s: string) => `/api/sections/${sec}/assignments/${a}/manual-scores/${pid(s)}`;
      expect((await teacher().put(path(exam, "st1"), { points: 101 })).status).toBe(400);
      expect((await teacher().put(path(exam, "st4"), { points: 50 })).status).toBe(400); // 不在班里
      expect((await teacher().put(path(exam, "st1"), { points: 12.345 })).status).toBe(400);
      expect((await other().put(path(exam, "st1"), { points: 50 })).status).toBe(404);
      expect((await registrar().put(path(exam, "st1"), { points: 50 })).status).toBe(403);
      expect((await as("st1").put(path(exam, "st1"), { points: 100 })).status).toBe(403);
      for (const [n, p] of [["st1", 90], ["st2", 70], ["st3", 50]] as const) expect((await teacher().put(path(exam, n), { points: p })).status).toBe(200);
      expect((await teacher().put(path(exam, "st3"), { points: null })).status).toBe(200); // 删除
      expect((await teacher().put(path(exam, "st3"), { points: 50 })).status).toBe(200);
    });

    it("the total is Σ(group rate × weight); missing work counts as zero; the grade comes from the scale", async () => {
      await submitAndPublish("st1", hw, [5, 4]);
      const unpublished = await submitAndPublish("st2", hw, [3, 2]); // 先不发布 st2 的作业分数
      let sub1 = (await teacher().get(`/api/sections/${sec}/assignments/${hw}/submissions`)).body.rows.find((r: { fullName: string }) => r.fullName === "st1").submissionId;
      await teacher().post(`/api/sections/${sec}/assignments/${hw}/submissions/${sub1}/publish`);
      // st2 的分数没发布：总评不能算，也不会悄悄当 0
      expect((await row("st2")).cells[hw].state).toBe("unpublished");
      const blocked = await teacher().post(`/api/sections/${sec}/final-grades/calculate`);
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe("PENDING_SUBMISSIONS");
      await teacher().post(`/api/sections/${sec}/assignments/${hw}/submissions/${unpublished}/publish`);
      sub1 = "";
      const b = await book();
      const byName = (n: string) => b.students.find((s: { fullName: string }) => s.fullName === n);
      expect(byName("st1")).toMatchObject({ total: 90, grade: "A" }); // HW 9/10×40 + 90/100×60
      expect(byName("st2")).toMatchObject({ total: 62, grade: "D" }); // 5/10×40 + 70/100×60
      expect(byName("st3")).toMatchObject({ total: 30, grade: "F" }); // 缺交 0 + 50/100×60
      expect(byName("st3").cells[hw]).toEqual({ points: null, state: "missing" });
    });

    it("the CSV export uses the same scope; formulas are neutralised; a teacher of another section cannot export", async () => {
      await h.owner.person.update({ where: { id: pid("st3") }, data: { fullName: "=HYPERLINK(1)" } });
      const res = await teacher().get(`/api/sections/${sec}/gradebook.csv`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/csv/);
      expect(res.text.startsWith("﻿\"Student no.\"")).toBe(true);
      expect(res.text).toContain("\"'=HYPERLINK(1)\"");
      expect(res.text).toContain("\"90\",\"A\"");
      await h.owner.person.update({ where: { id: pid("st3") }, data: { fullName: "st3" } });
      expect((await other().get(`/api/sections/${sec}/gradebook.csv`)).status).toBe(404);
      expect((await as("st1").get(`/api/sections/${sec}/gradebook.csv`)).status).toBe(403);
    });
  });

  describe("final grades: draft, publish, passed", () => {
    it("calculating makes drafts the student cannot see; publishing releases them and writes enrollment.passed", async () => {
      expect((await teacher().post(`/api/sections/${sec}/final-grades/publish`)).status).toBe(409); // 还没算
      expect((await teacher().post(`/api/sections/${sec}/final-grades/calculate`)).body).toEqual({ calculated: 3, changed: 0 });
      const before = await as("st1").get("/api/portal/grades");
      expect(before.body.terms[0].rows[0]).toMatchObject({ state: "in_progress", grade: null });
      expect((await h.owner.enrollment.findFirstOrThrow({ where: { sectionId: sec, studentPersonId: pid("st1") } })).passed).toBeNull();
      expect((await teacher().post(`/api/sections/${sec}/final-grades/publish`)).body).toEqual({ published: 3 });
      const passed = Object.fromEntries((await h.owner.enrollment.findMany({ where: { sectionId: sec } })).map((e) => [e.studentPersonId, e.passed]));
      expect(passed).toEqual({ [pid("st1")]: true, [pid("st2")]: true, [pid("st3")]: false }); // D 及格，F 不及格
      const after = (await as("st1").get("/api/portal/grades")).body;
      expect(after.terms[0].rows[0]).toMatchObject({ state: "graded", grade: "A", total: 90, gradePoints: 4 });
      expect(after.cumulative).toEqual({ gpa: 4, creditsAttempted: 4, creditsEarned: 4 });
      expect(after.progress.creditsEarned).toBe(4);
    });

    it("a student sees only their own grades", async () => {
      const mine = (await as("st2").get("/api/portal/grades")).body;
      expect(mine.student.fullName).toBe("st2");
      expect(JSON.stringify(mine)).not.toContain(pid("st1"));
      expect((await teacher().get("/api/portal/grades")).status).toBe(403);
    });
  });

  describe("transcripts", () => {
    it("a retake replaces the old result in the GPA, credits count once, and a withdrawal is listed but not counted", async () => {
      // st3 在下一学期重修同一门课（拿到 B），并退过另一门课（W）
      const term2 = await h.owner.term.create({ data: { tenantId: h.tenant.tenantId, code: "2027S", name: "2027 Spring", startDate: new Date(Date.now() + 120 * 864e5), endDate: new Date(Date.now() + 200 * 864e5), status: "ended" } });
      const cs301 = (await h.owner.section.findUniqueOrThrow({ where: { id: sec } })).courseId;
      const other2 = await h.owner.course.create({ data: { tenantId: h.tenant.tenantId, code: "CS399", name: "Elective", credits: 2 } });
      const sec2 = await h.owner.section.create({ data: { tenantId: h.tenant.tenantId, courseId: cs301, termId: term2.id, campusId: hqCampus, number: "02", name: "CS301-02", capacity: 5, status: "ended" } });
      const sec3 = await h.owner.section.create({ data: { tenantId: h.tenant.tenantId, courseId: other2.id, termId: term2.id, campusId: hqCampus, number: "01", name: "CS399-01", capacity: 5, status: "ended" } });
      const retake = await h.owner.enrollment.create({ data: { tenantId: h.tenant.tenantId, sectionId: sec2.id, studentPersonId: pid("st3"), status: "completed", passed: true } });
      await h.owner.finalGrade.create({ data: { tenantId: h.tenant.tenantId, enrollmentId: retake.id, total: 83, grade: "B", gradePoints: 3, passed: true, publishedAt: new Date() } });
      await h.owner.enrollment.create({ data: { tenantId: h.tenant.tenantId, sectionId: sec3.id, studentPersonId: pid("st3"), status: "withdrawn" } });
      const t = (await as("st3").get("/api/portal/grades")).body;
      const rows = t.terms.flatMap((x: { rows: Array<{ courseCode: string; state: string; replaced: boolean }> }) => x.rows);
      expect(rows.find((r: { courseCode: string; replaced: boolean }) => r.courseCode === "CS301" && r.replaced)).toBeTruthy(); // 旧的 F 标"已重修"
      expect(rows.find((r: { courseCode: string }) => r.courseCode === "CS399").state).toBe("withdrawn");
      expect(t.cumulative).toEqual({ gpa: 3, creditsAttempted: 4, creditsEarned: 4 }); // 只算重修后的 B（4 学分），W 不计
    });

    it("students download an unofficial PDF with its own number; every copy is recorded; transcript-mode students can too", async () => {
      const a = await as("st1").get("/api/portal/transcript.pdf").buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); });
      expect(a.status).toBe(200);
      expect(a.headers["content-type"]).toBe("application/pdf");
      expect((a.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
      const b = await as("st1").get("/api/portal/transcript.pdf");
      const numbers = (await h.owner.transcriptIssue.findMany({ where: { studentPersonId: pid("st1") }, orderBy: { generatedAt: "asc" } })).map((i) => [i.docNumber, i.version]);
      expect(b.status).toBe(200);
      expect(numbers).toHaveLength(2);
      expect(numbers[0][0]).not.toBe(numbers[1][0]);
      expect(numbers.every(([n, v]) => /^TR-\d{4}-\d{6}$/.test(n) && v === "informal")).toBe(true);
      await h.owner.studentProfile.updateMany({ where: { personId: pid("st1") }, data: { academicStatus: "graduated" } });
      expect((await as("st1").get("/api/portal/transcript.pdf")).status).toBe(200);
      expect((await as("st1").get("/api/portal/grades")).status).toBe(200);
      await h.owner.studentProfile.updateMany({ where: { personId: pid("st1") }, data: { academicStatus: "enrolled" } });
    });

    it("only the registrar issues the official copy (numbered, recorded, audited); students and teachers cannot", async () => {
      const res = await registrar().post(`/api/transcripts/${pid("st1")}/formal`);
      expect(res.status).toBe(201);
      expect(res.headers["content-type"]).toBe("application/pdf");
      const formal = await h.owner.transcriptIssue.findFirstOrThrow({ where: { studentPersonId: pid("st1"), version: "formal" } });
      expect(formal.docNumber).toMatch(/^TR-\d{4}-\d{6}$/);
      expect(res.headers["content-disposition"]).toContain(formal.docNumber);
      expect((await as("st1").post(`/api/transcripts/${pid("st1")}/formal`)).status).toBe(403);
      expect((await teacher().post(`/api/transcripts/${pid("st1")}/formal`)).status).toBe(403);
      const view = (await registrar().get(`/api/transcripts/${pid("st1")}`)).body;
      expect(view.transcript.student.fullName).toBe("st1");
      expect(view.issues.some((i: { version: string }) => i.version === "formal")).toBe(true);
      expect((await registrar().get("/api/transcripts/11111111-1111-4111-8111-111111111111")).status).toBe(404);
    });
  });

  describe("locking and amendments", () => {
    beforeAll(async () => {
      // 结课：班级已结束，已选记录转为"已完成"
      await h.owner.section.update({ where: { id: sec }, data: { status: "ended" } });
      await h.owner.enrollment.updateMany({ where: { sectionId: sec, status: "enrolled" }, data: { status: "completed" } });
    });

    it("after the section ended the teacher can no longer change anything", async () => {
      expect((await teacher().put(`/api/sections/${sec}/grade-policy`, { groups: [{ id: hwGroup, weight: 50 }, { id: examGroup, weight: 50 }] })).status).toBe(409);
      expect((await teacher().put(`/api/sections/${sec}/assignments/${exam}/manual-scores/${pid("st3")}`, { points: 100 })).status).toBe(409);
      expect((await teacher().post(`/api/sections/${sec}/final-grades/calculate`)).status).toBe(409);
      expect((await teacher().post(`/api/sections/${sec}/final-grades/publish`)).status).toBe(409);
    });

    it("the registrar amends one student with a reason; before and after are recorded; the passed flag follows the scale", async () => {
      const enr = (await h.owner.enrollment.findFirstOrThrow({ where: { sectionId: sec, studentPersonId: pid("st3") } })).id;
      const path = `/api/sections/${sec}/final-grades/${enr}`;
      expect((await registrar().put(path, { total: 65 })).status).toBe(400); // 要写原因
      expect((await registrar().put(path, { total: 65, reason: "ok" })).status).toBe(400); // 原因太短
      expect((await teacher().put(path, { total: 65, reason: "teacher tries" })).status).toBe(403);
      expect((await other().put(path, { total: 65, reason: "not my class" })).status).toBe(403);
      const res = await registrar().put(path, { total: 65, reason: "Exam re-marked after appeal" });
      expect(res.body).toMatchObject({ total: 65, grade: "D", passed: true });
      expect((await h.owner.enrollment.findUniqueOrThrow({ where: { id: enr } })).passed).toBe(true);
      const log = (await registrar().get(`/api/sections/${sec}/grade-changes`)).body;
      expect(log[0]).toMatchObject({ kind: "amend", before: { total: 30, grade: "F", passed: false }, after: { total: 65, grade: "D", passed: true }, reason: "Exam re-marked after appeal" });
      expect((await as("st3").get("/api/portal/grades")).body.terms.flatMap((t: { rows: Array<{ sectionName: string; total: number }> }) => t.rows).find((r: { sectionName: string }) => r.sectionName.startsWith("CS301-01")).total).toBe(65);
    });

    it("a locked recalculation needs the amend permission and a reason, and records every change", async () => {
      expect((await registrar().post(`/api/sections/${sec}/final-grades/recalculate`, {})).status).toBe(400);
      expect((await teacher().post(`/api/sections/${sec}/final-grades/recalculate`, { reason: "teacher tries it" })).status).toBe(403);
      const res = await registrar().post(`/api/sections/${sec}/final-grades/recalculate`, { reason: "Policy corrected, recalculating" });
      expect(res.status).toBe(201);
      expect(res.body.changed).toBe(1); // 只有被更正过的 st3 从 65 变回 30
      const log = (await registrar().get(`/api/sections/${sec}/grade-changes`)).body;
      expect(log.filter((l: { kind: string }) => l.kind === "amend_recalc")).toHaveLength(1);
      expect((await h.owner.enrollment.findFirstOrThrow({ where: { sectionId: sec, studentPersonId: pid("st3") } })).passed).toBe(false);
    });
  });

  describe("grading scale", () => {
    it("starts with the default scale; the registrar can change it; broken scales are refused; teachers cannot", async () => {
      const first = (await registrar().get("/api/grading-scale")).body;
      expect(first.isDefault).toBe(true);
      expect(first.items.map((i: { grade: string }) => i.grade)).toEqual(["A", "B", "C", "D", "F"]);
      const custom = [
        { grade: "A+", minPercent: 95, points: 4, passing: true }, { grade: "A", minPercent: 90, points: 4, passing: true }, { grade: "B", minPercent: 80, points: 3, passing: true },
        { grade: "C", minPercent: 70, points: 2, passing: true }, { grade: "F", minPercent: 0, points: 0, passing: false },
      ];
      expect((await registrar().put("/api/grading-scale", { items: custom.slice(0, 4) })).status).toBe(400); // 没有 0%
      expect((await registrar().put("/api/grading-scale", { items: custom.map((c) => (c.grade === "B" ? { ...c, passing: false } : c)) })).status).toBe(400);
      expect((await teacher().put("/api/grading-scale", { items: custom })).status).toBe(403);
      const saved = await registrar().put("/api/grading-scale", { items: custom });
      expect(saved.body.isDefault).toBe(false);
      expect((await h.call(boss).get("/api/audit-logs?size=100")).body.some((l: { action: string }) => l.action === "grading_scale.update")).toBe(true);
      expect((await registrar().post("/api/grading-scale/reset")).body.isDefault).toBe(true);
    });
  });

  describe("dashboard: aggregates only inside the data scope", () => {
    let shSection: string;
    beforeAll(async () => {
      const sh = (await h.call(boss).post("/api/campuses", { code: "SH", name: "Shanghai", timezone: "Asia/Shanghai" })).body;
      const cs401 = (await registrar().post("/api/courses", { code: "CS401", name: "Systems", credits: 3 })).body.id;
      shSection = await mkSection(cs401, "01", ["st4"], sh.id);
      await registrar().post(`/api/sections/${shSection}/status`, { status: "in_progress" });
    });

    it("the registrar (all campuses) sees both campuses; a campus lead sees only their own — totals exclude the rest", async () => {
      const all = (await registrar().get("/api/dashboard/overview")).body;
      expect(all.campuses.map((c: { campus: string }) => c.campus).sort()).toHaveLength(2);
      expect(all.totals.students).toBeGreaterThanOrEqual(4);
      const lead = await (await h.user("lead.hq", { roles: ["campus-lead"], person: "staff", deptIds: [hqDept] })).token();
      const mine = (await h.call(lead).get("/api/dashboard/overview")).body;
      expect(mine.campuses).toHaveLength(1);
      expect(mine.campuses[0].campus).not.toBe("Shanghai");
      expect(mine.totals.students).toBe(3); // st4 在上海，不在范围内
      const total = all.campuses.reduce((s: number, c: { students: number }) => s + c.students, 0);
      expect(total).toBe(all.totals.students);
      expect(all.campuses.find((c: { campus: string }) => c.campus === "Shanghai").students).toBe(1);
    });

    it("class analysis: score distribution and the weakest assignments; other teachers and students are refused", async () => {
      const a = (await teacher().get(`/api/dashboard/sections/${sec}`)).body;
      expect(a.students).toBe(3);
      expect(a.distribution.reduce((s: number, b: { count: number }) => s + b.count, 0)).toBe(3);
      expect(a.weakAssignments[0].title).toBe("HW1"); // 作业和期末的平均得分率都是 70%，并列时先出现的排前面
      expect((await other().get(`/api/dashboard/sections/${sec}`)).status).toBe(404);
      expect((await as("st1").get(`/api/dashboard/sections/${sec}`)).status).toBe(403);
      expect((await as("st1").get("/api/dashboard/overview")).status).toBe(403);
    });
  });
});
