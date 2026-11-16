// 学生申请：成绩复评与作业延期。学生提交 → 任课教师/教务处理 → 通知学生，全程留痕；规则在服务端强制。
import { Harness, type TestUser } from "../helpers/app";

const iso = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

describe("student requests: grade appeals and extensions", () => {
  const h = new Harness();
  let reg: string;
  let sec: string;
  let hw1: string;
  let hw2: string;
  let exam: string;
  let teacher1: TestUser;
  let t1: string;
  let t2: string;
  const registrar = () => h.call(reg);
  const teacher = () => h.call(t1);
  const other = () => h.call(t2);
  const stu: Record<string, { u: TestUser; token: string }> = {};
  const as = (n: string) => h.call(stu[n].token);
  const pid = (n: string) => stu[n].u.personId as string;
  const extend = (n: string, assignmentId: string, days = 2, reason = "family emergency") => as(n).post("/api/portal/requests", { kind: "extension", assignmentId, days, reason });
  const appeal = (n: string, enrollmentId: string, reason = "I believe the exam was marked wrongly") => as(n).post("/api/portal/requests", { kind: "grade_appeal", enrollmentId, reason });
  const enrollmentOf = (n: string) => h.owner.enrollment.findFirstOrThrow({ where: { sectionId: sec, studentPersonId: pid(n) } }).then((e) => e.id);

  beforeAll(async () => {
    await h.start();
    const campus = await h.owner.campus.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, type: "hq" } });
    reg = await (await h.user("registrar", { roles: ["academic-manager"], person: "staff", deptIds: [campus.deptId] })).token();
    teacher1 = await h.user("teacher.one", { roles: ["teacher"], person: "staff", deptIds: [campus.deptId] });
    t1 = await teacher1.token();
    t2 = await (await h.user("teacher.two", { roles: ["teacher"], person: "staff", deptIds: [campus.deptId] })).token();
    for (const n of ["st1", "st2", "st3"]) {
      const u = await h.user(n, { roles: ["student"], person: "student" });
      stu[n] = { u, token: await u.token() };
    }
    const termId = (await registrar().post("/api/terms", { code: "2026F", name: "2026 Fall", startDate: iso(-10), endDate: iso(80), enrollOpenDate: iso(-5), enrollCloseDate: iso(10), dropDeadline: iso(20) })).body.id;
    await registrar().post(`/api/terms/${termId}/status`, { status: "enrolling" });
    const course = (await registrar().post("/api/courses", { code: "RQ101", name: "Requests", credits: 3 })).body.id;
    sec = (await registrar().post("/api/sections", { courseId: course, termId, campusId: campus.id, number: "01", capacity: 20, schedule: [] })).body.id;
    await registrar().put(`/api/sections/${sec}/instructors`, { items: [{ personId: teacher1.personId, role: "lead" }] });
    await registrar().post(`/api/sections/${sec}/status`, { status: "open" });
    await registrar().post(`/api/sections/${sec}/enrollments`, { studentIds: ["st1", "st2", "st3"].map(pid) });
    const group = (await teacher().post(`/api/sections/${sec}/assignment-groups`, { name: "All" })).body.id;
    const mk = async (body: object) => {
      const a = (await teacher().post(`/api/sections/${sec}/assignments`, { dueDate: iso(3), groupId: group, ...body })).body.id as string;
      await teacher().post(`/api/sections/${sec}/assignments/${a}/publish`, { published: true });
      return a;
    };
    hw1 = await mk({ title: "HW1", rubric: [{ title: "Work", maxPoints: 10 }] });
    hw2 = await mk({ title: "HW2", rubric: [{ title: "Work", maxPoints: 10 }] });
    exam = await mk({ title: "Exam", manualOnly: true, rubric: [{ title: "Exam", maxPoints: 100 }] });
  });
  afterAll(() => h.stop());

  describe("extension requests", () => {
    let reqId: string;

    it("a student sees what they can ask for and submits a request; the instructors are notified", async () => {
      const opts = (await as("st1").get("/api/portal/requests/options")).body;
      expect(opts.extensions.map((e: { title: string }) => e.title).sort()).toEqual(["HW1", "HW2"]); // 只能手工录分的（Exam）没有在线截止，不在可申请之列
      expect((await extend("st1", exam)).status).toBe(409);
      expect(opts.appeals).toEqual([]); // 没有已发布的成绩
      expect((await extend("st1", hw1, 2, "ab")).status).toBe(400); // 原因太短
      expect((await extend("st1", hw1, 4)).status).toBe(400); // 最多 3 天
      expect((await as("st1").post("/api/portal/requests", { kind: "extension", assignmentId: hw1, days: 2, reason: "family emergency", extra: 1 })).status).toBe(400);
      const res = await extend("st1", hw1);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ kind: "extension", status: "pending", assignment: "HW1", days: 2 });
      reqId = res.body.id;
      expect(await h.owner.outboxEvent.count({ where: { tenantId: h.tenant.tenantId, type: "request.submitted", payload: { path: ["requestId"], equals: reqId } } })).toBe(1);
    });

    it("only one pending request per assignment; each student has their own; others cannot ask for someone else's assignment", async () => {
      expect((await extend("st1", hw1)).body.code).toBe("ALREADY_PENDING");
      expect((await extend("st2", hw1)).status).toBe(201);
      await h.owner.studentRequest.deleteMany({ where: { studentPersonId: pid("st2") } });
      expect((await extend("st1", "11111111-1111-4111-8111-111111111111")).status).toBe(404);
    });

    it("the instructor sees it, another teacher does not, a student cannot decide", async () => {
      const mine = (await teacher().get("/api/requests?status=pending")).body;
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ id: reqId, student: "st1", section: expect.any(String), assignment: { title: "HW1" } });
      expect((await other().get("/api/requests")).body).toEqual([]);
      expect((await other().post(`/api/requests/${reqId}/decide`, { decision: "approve", note: "fine" })).status).toBe(404);
      expect((await as("st1").get("/api/requests")).status).toBe(403);
      expect((await as("st1").post(`/api/requests/${reqId}/decide`, { decision: "approve", note: "fine" })).status).toBe(403);
      expect((await teacher().get("/api/requests?status=bogus")).status).toBe(400);
    });

    it("approving sets the extension like a manual one (days may be adjusted), notifies the student and cannot be repeated", async () => {
      expect((await teacher().post(`/api/requests/${reqId}/decide`, { decision: "approve", note: "x" })).status).toBe(400); // 说明至少 3 个字
      const res = await teacher().post(`/api/requests/${reqId}/decide`, { decision: "approve", note: "ok, three days", days: 3 });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: "approved", result: { days: 3 } });
      expect(await h.owner.assignmentExtension.findFirst({ where: { assignmentId: hw1, studentPersonId: pid("st1") } })).toMatchObject({ days: 3 });
      expect((await teacher().post(`/api/requests/${reqId}/decide`, { decision: "reject", note: "again" })).body.code).toBe("NOT_PENDING");
      expect(await h.owner.outboxEvent.count({ where: { tenantId: h.tenant.tenantId, type: "request.decided", payload: { path: ["requestId"], equals: reqId } } })).toBe(1);
      expect(await h.owner.auditLog.count({ where: { tenantId: h.tenant.tenantId, action: "request.decide", targetId: sec } })).toBeGreaterThan(0);
      // 已经延期 3 天：不能再申请不超过它的天数
      expect((await extend("st1", hw1, 3)).body.code).toBe("ALREADY_EXTENDED");
      expect((await as("st1").get("/api/portal/requests/options")).body.extensions.map((e: { title: string }) => e.title)).not.toContain("HW1");
    });

    it("a rejection needs a note; the student can withdraw a pending request but not someone else's", async () => {
      const a = (await extend("st2", hw2)).body.id as string;
      const rej = await registrar().post(`/api/requests/${a}/decide`, { decision: "reject", note: "no good reason" });
      expect(rej.body.status).toBe("rejected");
      expect(await h.owner.assignmentExtension.count({ where: { assignmentId: hw2, studentPersonId: pid("st2") } })).toBe(0);
      const b = (await extend("st2", hw2)).body.id as string; // 驳回后可以再申请
      expect((await as("st3").post(`/api/portal/requests/${b}/withdraw`)).status).toBe(404);
      expect((await as("st2").post(`/api/portal/requests/${b}/withdraw`)).body.status).toBe("withdrawn");
      expect((await as("st2").post(`/api/portal/requests/${b}/withdraw`)).status).toBe(400);
      expect((await registrar().post(`/api/requests/${b}/decide`, { decision: "approve", note: "too late" })).body.code).toBe("NOT_PENDING");
      expect((await as("st2").get("/api/portal/requests")).body.map((r: { status: string }) => r.status)).toEqual(["withdrawn", "rejected"]);
    });

    it("no request after the deadline or once the submission is being graded", async () => {
      await h.owner.assignment.update({ where: { id: hw2 }, data: { dueAt: new Date(Date.now() - 3600_000) } });
      expect((await extend("st3", hw2)).body.code).toBe("DEADLINE_PASSED");
      await h.owner.assignment.update({ where: { id: hw2 }, data: { dueAt: new Date(Date.now() + 3 * 864e5) } });
      expect((await as("st3").post(`/api/portal/assignments/${hw2}/submissions`, { text: "done" })).status).toBe(201);
      const sub = (await teacher().get(`/api/sections/${sec}/assignments/${hw2}/submissions`)).body.rows.find((r: { fullName: string }) => r.fullName === "st3").submissionId;
      const items = (await teacher().get(`/api/sections/${sec}/assignments/${hw2}`)).body.rubric;
      await teacher().put(`/api/sections/${sec}/assignments/${hw2}/submissions/${sub}/grade`, { scores: [{ rubricItemId: items[0].id, points: 8 }] });
      expect((await extend("st3", hw2)).status).toBe(409);
    });
  });

  describe("grade appeals", () => {
    const manual = (n: string, points: number) => teacher().put(`/api/sections/${sec}/assignments/${exam}/manual-scores/${pid(n)}`, { points });

    it("there is nothing to appeal until the final grade is published", async () => {
      expect((await appeal("st1", await enrollmentOf("st1"))).status).toBe(409);
      const group = (await h.owner.assignmentGroup.findMany({ where: { sectionId: sec } }))[0];
      expect((await teacher().put(`/api/sections/${sec}/grade-policy`, { groups: [{ id: group.id, weight: 100 }] })).status).toBe(200);
      // 把作业算进去会要求都批改完：本测试只让 Exam 计入
      await h.owner.assignment.updateMany({ where: { id: { in: [hw1, hw2] } }, data: { groupId: null } });
      for (const [n, p] of [["st1", 60], ["st2", 85], ["st3", 70]] as const) expect((await manual(n, p)).status).toBe(200);
      expect((await teacher().post(`/api/sections/${sec}/final-grades/calculate`)).status).toBe(201);
      expect((await teacher().post(`/api/sections/${sec}/final-grades/publish`)).status).toBe(201);
    });

    it("a student can appeal only their own published grade, with a real reason", async () => {
      const e1 = await enrollmentOf("st1");
      expect((await as("st1").get("/api/portal/requests/options")).body.appeals).toMatchObject([{ enrollmentId: e1, total: 60 }]);
      expect((await appeal("st1", e1, "unfair")).status).toBe(400); // 原因至少 10 个字
      expect((await appeal("st2", e1)).status).toBe(404); // 别人的成绩
      const res = await appeal("st1", e1);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ kind: "appeal".replace("appeal", "grade_appeal"), status: "pending" });
      expect((await appeal("st1", e1)).body.code).toBe("ALREADY_PENDING");
    });

    it("an instructor can see and reject it but cannot change the grade; approving needs the amend permission, a new total and a note", async () => {
      const pending = (await teacher().get("/api/requests?status=pending")).body.find((r: { kind: string }) => r.kind === "grade_appeal");
      expect(pending).toMatchObject({ student: "st1", currentGrade: { total: 60 } });
      expect((await teacher().post(`/api/requests/${pending.id}/decide`, { decision: "approve", note: "re-marked", total: 75 })).status).toBe(403);
      expect((await registrar().post(`/api/requests/${pending.id}/decide`, { decision: "approve", note: "re-marked" })).status).toBe(400); // 没给新总评
      expect((await registrar().post(`/api/requests/${pending.id}/decide`, { decision: "approve", note: "ok", total: 75 })).status).toBe(400); // 说明至少 5 个字
      expect((await registrar().post(`/api/requests/${pending.id}/decide`, { decision: "approve", note: "re-marked", total: 101 })).status).toBe(400);
      expect((await h.owner.finalGrade.findUniqueOrThrow({ where: { enrollmentId: await enrollmentOf("st1") } })).total.toString()).toBe("60"); // 失败的尝试没有改任何东西
      const done = await registrar().post(`/api/requests/${pending.id}/decide`, { decision: "approve", note: "question 3 was marked wrongly", total: 75 });
      expect(done.status).toBe(201);
      expect(done.body.result).toMatchObject({ before: { total: 60 }, after: { total: 75 } });
      const e1 = await enrollmentOf("st1");
      expect(Number((await h.owner.finalGrade.findUniqueOrThrow({ where: { enrollmentId: e1 } })).total)).toBe(75);
      const change = await h.owner.gradeChange.findFirstOrThrow({ where: { enrollmentId: e1, kind: "amend" } });
      expect(change.reason).toContain("Grade appeal");
    });

    it("a rejection by the instructor keeps the grade; at most two appeals per course", async () => {
      const e2 = await enrollmentOf("st2");
      const first = (await appeal("st2", e2)).body.id as string;
      expect((await teacher().post(`/api/requests/${first}/decide`, { decision: "reject", note: "the marking was correct" })).body.status).toBe("rejected");
      expect(Number((await h.owner.finalGrade.findUniqueOrThrow({ where: { enrollmentId: e2 } })).total)).toBe(85);
      const second = (await appeal("st2", e2)).body.id as string;
      expect((await as("st2").post(`/api/portal/requests/${second}/withdraw`)).status).toBe(201); // 撤回的不占次数
      expect((await appeal("st2", e2)).status).toBe(201);
      const third = (await as("st2").get("/api/portal/requests")).body.filter((r: { kind: string; status: string }) => r.kind === "grade_appeal" && r.status !== "withdrawn");
      expect(third).toHaveLength(2);
      await h.owner.studentRequest.updateMany({ where: { id: third[0].id }, data: { status: "rejected" } });
      expect((await appeal("st2", e2)).body.code).toBe("APPEAL_LIMIT");
    });

    it("the appeal window closes 14 days after publication", async () => {
      const e3 = await enrollmentOf("st3");
      await h.owner.finalGrade.update({ where: { enrollmentId: e3 }, data: { publishedAt: new Date(Date.now() - 15 * 864e5) } });
      expect((await appeal("st3", e3)).body.code).toBe("APPEAL_WINDOW_CLOSED");
      expect((await as("st3").get("/api/portal/requests/options")).body.appeals).toEqual([]);
    });
  });
});
