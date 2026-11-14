// 批量安排选课：按"专业 + 入学年份 + 校区"选出学生，放进自己校区、剩余名额最多的班级；
// 预览不写入；规则和单个代选相同（超员要确认并填原因）；重复执行不会重复选；一个人失败不影响其他人。
import { Harness, type TestUser } from "../helpers/app";

const iso = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

describe("batch enrollment", () => {
  const h = new Harness();
  let boss: string;
  let reg: string;
  let hqCampus: string;
  let shCampus: string;
  let termId: string;
  let major: string;
  let course: string;
  let teacher: TestUser;
  const registrar = () => h.call(reg);
  const batch = (body: Record<string, unknown>) => registrar().post("/api/enrollment-batches", { termId, courseId: course, majorId: major, ...body });

  async function student(name: string, entryYear: number, campusId = hqCampus, status: "enrolled" | "on_leave" = "enrolled") {
    const u = await h.user(name, { roles: ["student"], person: "student", studentStatus: status });
    await h.owner.studentProfile.update({ where: { personId: u.personId! }, data: { campusId } });
    expect((await registrar().put(`/api/majors/${major}/students/${u.personId}`, { kind: "primary", entryYear })).status).toBe(200);
    return u;
  }
  async function section(courseId: string, campusId: string, number: string, capacity: number) {
    const id = (await registrar().post("/api/sections", { courseId, termId, campusId, number, capacity, schedule: [] })).body.id as string;
    expect((await registrar().put(`/api/sections/${id}/instructors`, { items: [{ personId: teacher.personId, role: "lead" }] })).status).toBe(200);
    expect((await registrar().post(`/api/sections/${id}/status`, { status: "open" })).status).toBe(201);
    return id;
  }
  const enrolled = (sectionIds: string[]) => h.owner.enrollment.count({ where: { sectionId: { in: sectionIds }, status: "enrolled" } });

  let hqA: string;
  let hqB: string;
  let shA: string;
  let s26: TestUser[];
  let sSh: TestUser[];
  let s25: TestUser;
  let onLeave: TestUser;

  beforeAll(async () => {
    await h.start();
    boss = await (await h.user("boss", { roles: ["tenant-admin"], person: "staff" })).token();
    const hq = await h.owner.campus.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, type: "hq" } });
    hqCampus = hq.id;
    reg = await (await h.user("registrar", { roles: ["academic-manager"], person: "staff", deptIds: [hq.deptId] })).token();
    teacher = await h.user("teacher.b", { roles: ["teacher"], person: "staff", deptIds: [hq.deptId] });
    shCampus = (await h.call(boss).post("/api/campuses", { code: "SH", name: "Shanghai" })).body.id;
    termId = (await registrar().post("/api/terms", { code: "2026F", name: "2026 Fall", startDate: iso(-10), endDate: iso(80), enrollOpenDate: iso(-5), enrollCloseDate: iso(10), dropDeadline: iso(20) })).body.id;
    await registrar().post(`/api/terms/${termId}/status`, { status: "enrolling" });
    course = (await registrar().post("/api/courses", { code: "BA101", name: "Batch course", credits: 3 })).body.id;
    major = (await registrar().post("/api/majors", { code: "BA", name: "Batch major", totalCredits: 3 })).body.id;
    hqA = await section(course, hqCampus, "01", 2);
    hqB = await section(course, hqCampus, "02", 5);
    shA = await section(course, shCampus, "03", 5);
    s26 = [await student("b.hq1", 2026), await student("b.hq2", 2026), await student("b.hq3", 2026)];
    sSh = [await student("b.sh1", 2026, shCampus), await student("b.sh2", 2026, shCampus)];
    s25 = await student("b.old", 2025);
    onLeave = await student("b.leave", 2026, hqCampus, "on_leave");
  });
  afterAll(() => h.stop());

  it("previews without writing: each student goes to a section at their own campus; others are reported, not dropped silently", async () => {
    const res = await batch({ entryYear: 2026 });
    expect(res.status).toBe(201);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.summary).toEqual({ selected: 6, ok: 5, needConfirmation: 0, blocked: 1 });
    const by = (u: TestUser) => res.body.rows.find((r: { studentId: string }) => r.studentId === u.personId);
    for (const u of s26) expect([hqA, hqB]).toContain(by(u).sectionId);
    for (const u of sSh) expect(by(u).sectionId).toBe(shA);
    expect(by(onLeave)).toMatchObject({ ok: false, code: "NOT_ENROLLED" });
    expect(res.body.rows.find((r: { studentId: string }) => r.studentId === s25.personId)).toBeUndefined(); // 入学年份不符，不在这一批
    expect(await enrolled([hqA, hqB, shA])).toBe(0); // 预览什么都没写
  });

  it("narrows by campus and entry year", async () => {
    expect((await batch({ entryYear: 2026, campusId: shCampus })).body.summary.selected).toBe(2);
    expect((await batch({ entryYear: 2025 })).body.summary.selected).toBe(1);
    expect((await batch({})).body.summary.selected).toBe(7); // 不限入学年份：全部申报了这个专业的
  });

  it("runs for real, audits once, and a second run adds nobody", async () => {
    const res = await batch({ entryYear: 2026, dryRun: false });
    expect(res.status).toBe(201);
    expect(res.body.summary).toMatchObject({ selected: 6, ok: 5, blocked: 1 });
    expect(await enrolled([hqA, hqB, shA])).toBe(5);
    const rows = await h.owner.enrollment.findMany({ where: { sectionId: { in: [hqA, hqB, shA] } } });
    expect(rows.every((r) => r.method === "registrar")).toBe(true);
    expect(await h.owner.auditLog.count({ where: { tenantId: h.tenant.tenantId, action: "enrollment.batch" } })).toBe(1);
    expect(await h.owner.auditLog.count({ where: { tenantId: h.tenant.tenantId, action: "enrollment.add" } })).toBe(5); // 每个人另有自己的留痕
    const again = await batch({ entryYear: 2026, dryRun: false });
    expect(again.body.summary.ok).toBe(0);
    expect(again.body.rows.filter((r: { code?: string }) => r.code === "DUPLICATE")).toHaveLength(5);
    expect(await enrolled([hqA, hqB, shA])).toBe(5);
  });

  it("over capacity needs confirmation with a reason, like a single registrar enrollment", async () => {
    const c2 = (await registrar().post("/api/courses", { code: "BA102", name: "Small", credits: 3 })).body.id as string;
    await registrar().put(`/api/majors/${major}/courses`, { items: [{ courseId: course, category: "required" }, { courseId: c2, category: "required" }] });
    const tiny = await section(c2, hqCampus, "01", 1);
    const first = await batch({ courseId: c2, entryYear: 2026, campusId: hqCampus, dryRun: false });
    expect(first.body.summary).toMatchObject({ selected: 4, ok: 1 }); // 3 个在读 + 1 个休学（被拦）；只有 1 个名额
    expect(first.body.summary.needConfirmation).toBe(2);
    expect(first.body.rows.find((r: { code?: string }) => r.code === "CONFIRMATION_REQUIRED").violations).toEqual(["capacity"]);
    expect(await enrolled([tiny])).toBe(1);
    const noReason = await batch({ courseId: c2, entryYear: 2026, campusId: hqCampus, dryRun: false, confirm: ["capacity"] });
    expect(noReason.body.summary.ok).toBe(0); // 确认了但没填原因，仍然不行
    const forced = await batch({ courseId: c2, entryYear: 2026, campusId: hqCampus, dryRun: false, confirm: ["capacity"], reason: "Approved by the dean" });
    expect(forced.body.summary.ok).toBe(2);
    expect(await enrolled([tiny])).toBe(3);
    const overridden = await h.owner.enrollment.findMany({ where: { sectionId: tiny, reason: "Approved by the dean" } });
    expect(overridden).toHaveLength(2);
  });

  it("reports students with no open section at their campus", async () => {
    const c3 = (await registrar().post("/api/courses", { code: "BA103", name: "Shanghai only", credits: 3 })).body.id as string;
    await section(c3, shCampus, "01", 5);
    const res = await batch({ courseId: c3, entryYear: 2026, campusId: hqCampus });
    expect(res.body.summary).toMatchObject({ selected: 4, ok: 0 });
    expect(res.body.rows.filter((r: { code?: string }) => r.code === "NO_SECTION")).toHaveLength(4);
  });

  it("validates input and ids, and needs the enrollment permission", async () => {
    expect((await batch({ extra: 1 })).status).toBe(400);
    expect((await batch({ entryYear: 1800 })).status).toBe(400);
    expect((await batch({ majorId: "11111111-1111-4111-8111-111111111111" })).status).toBeGreaterThanOrEqual(400);
    const stu = await (await h.user("b.nobody", { roles: ["student"], person: "student" })).token();
    expect((await h.call(stu).post("/api/enrollment-batches", { termId, courseId: course, majorId: major })).status).toBe(403);
  });
});
