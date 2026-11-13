// 作业与提交：分组、评分标准、发布、文件上传（预签名直传）、截止与迟交、延期、批改与发布、权限边界。
// 截止时间的推移用库所有者直接改 due_at 来模拟（不等真实时间）。
import { assertTenantKey, tenantPrefix } from "../../src/storage/object-store.service";
import { Harness, type TestUser } from "../helpers/app";

const iso = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const HOUR = 3_600_000;

describe("assignments, submissions and grading", () => {
  const h = new Harness();
  let boss: string;
  let reg: string;
  let t1: string;
  let t2: string;
  let teacher1: TestUser;
  let hqCampus: string;
  let hqDept: string;
  let termId: string;
  let courseId: string;
  let sec: string;
  const registrar = () => h.call(reg);
  const teacher = () => h.call(t1);
  const other = () => h.call(t2);
  const audit = () => h.call(boss);
  const stu: Record<string, { u: TestUser; token: string }> = {};
  const as = (name: string) => h.call(stu[name].token);
  const pid = (name: string) => stu[name].u.personId as string;

  async function student(name: string, status?: "enrolled" | "on_leave" | "graduated") {
    const u = await h.user(name, { roles: ["student"], person: "student", studentStatus: status });
    stu[name] = { u, token: await u.token() };
    return u;
  }

  async function mkSection(number: string, students: string[], course = courseId) {
    const created = await registrar().post("/api/sections", { courseId: course, termId, campusId: hqCampus, number, capacity: 20, schedule: [] });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect((await registrar().put(`/api/sections/${id}/instructors`, { items: [{ personId: teacher1.personId, role: "lead" }] })).status).toBe(200);
    expect((await registrar().post(`/api/sections/${id}/status`, { status: "open" })).status).toBe(201);
    if (students.length) {
      const res = await registrar().post(`/api/sections/${id}/enrollments`, { studentIds: students.map((s) => stu[s].u.personId) });
      expect(res.body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    }
    return id;
  }

  const rubric = [{ title: "Correctness", maxPoints: 6 }, { title: "Style", maxPoints: 4 }];
  async function assignment(over: Record<string, unknown> = {}, section = sec, publish = true) {
    const res = await h.call(t1).post(`/api/sections/${section}/assignments`, { title: "HW", dueDate: iso(3), rubric, ...over });
    expect(res.status).toBe(201);
    if (publish) expect((await h.call(t1).post(`/api/sections/${section}/assignments/${res.body.id}/publish`, { published: true })).status).toBe(201);
    return res.body.id as string;
  }
  /** 把截止时间挪到"现在 + hours 小时"（负数 = 已过期）。 */
  const setDue = (id: string, hours: number) => h.owner.assignment.update({ where: { id }, data: { dueAt: new Date(Date.now() + hours * HOUR) } });

  async function upload(who: string, assignmentId: string, name: string, bytes: Buffer) {
    const res = await as(who).post(`/api/portal/assignments/${assignmentId}/uploads`, { fileName: name, contentType: "text/plain", size: bytes.length });
    expect(res.status).toBe(201);
    const put = await fetch(res.body.uploadUrl, { method: "PUT", headers: res.body.headers, body: bytes });
    expect(put.status).toBe(200);
    return res.body.fileId as string;
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
    for (const n of ["st1", "st2", "st3", "s.leave", "s.out"]) await student(n);
    termId = (await registrar().post("/api/terms", { code: "2026F", name: "2026 Fall", startDate: iso(-10), endDate: iso(80), enrollOpenDate: iso(-5), enrollCloseDate: iso(10), dropDeadline: iso(20) })).body.id;
    await registrar().post(`/api/terms/${termId}/status`, { status: "enrolling" });
    courseId = (await registrar().post("/api/courses", { code: "CS201", name: "Web", credits: 3 })).body.id;
    sec = await mkSection("01", ["st1", "st2", "st3", "s.leave"]);
  });
  afterAll(() => h.stop());

  describe("authoring: groups, assignments, rubric, publishing", () => {
    it("the deadline is 23:59 on the due date in the campus time zone; the maximum score is the sum of the rubric", async () => {
      const campus = await h.owner.campus.findUniqueOrThrow({ where: { id: hqCampus } });
      const res = await teacher().post(`/api/sections/${sec}/assignments`, { title: "Deadline check", dueDate: "2030-06-15", rubric });
      expect(res.status).toBe(201);
      const { endOfLocalDay } = await import("../../src/edu/deadline");
      expect(new Date(res.body.dueAt).toISOString()).toBe(endOfLocalDay("2030-06-15", campus.timezone).toISOString());
      expect(res.body).toMatchObject({ dueDate: "2030-06-15", maxScore: 10, published: false, allowLate: true });
      expect(res.body.latePolicy.tiers).toHaveLength(3); // 默认迟交扣分表
      await teacher().del(`/api/sections/${sec}/assignments/${res.body.id}`);
    });

    it("validates input: dates, rubric points (positive, two decimals), late table order, foreign groups", async () => {
      const post = (body: object) => teacher().post(`/api/sections/${sec}/assignments`, { title: "x", dueDate: iso(2), ...body });
      expect((await post({ dueDate: "2030-13-40" })).status).toBe(400);
      expect((await post({ dueDate: "tomorrow" })).status).toBe(400);
      expect((await post({ rubric: [{ title: "Zero", maxPoints: 0 }] })).status).toBe(400);
      expect((await post({ rubric: [{ title: "Fine", maxPoints: 1.234 }] })).status).toBe(400);
      expect((await post({ title: "" })).status).toBe(400);
      expect((await post({ latePolicy: { tiers: [{ upToHours: 48, pct: 10 }, { upToHours: 24, pct: 20 }], beyondPct: 100 } })).status).toBe(400);
      expect((await post({ groupId: "11111111-1111-4111-8111-111111111111" })).status).toBe(400);
    });

    it("groups: unique names per section; a group in use cannot be deleted", async () => {
      const g = (await teacher().post(`/api/sections/${sec}/assignment-groups`, { name: "Homework" })).body;
      expect((await teacher().post(`/api/sections/${sec}/assignment-groups`, { name: "Homework" })).status).toBe(409);
      expect((await teacher().patch(`/api/sections/${sec}/assignment-groups/${g.id}`, { name: "Homework 1" })).status).toBe(200);
      const a = await assignment({ groupId: g.id, title: "Grouped" }, sec, false);
      expect((await teacher().del(`/api/sections/${sec}/assignment-groups/${g.id}`)).status).toBe(409);
      expect((await teacher().get(`/api/sections/${sec}/assignments/${a}`)).body.group).toMatchObject({ name: "Homework 1" });
      await teacher().del(`/api/sections/${sec}/assignments/${a}`);
      expect((await teacher().del(`/api/sections/${sec}/assignment-groups/${g.id}`)).status).toBe(200);
    });

    it("an assignment needs a rubric to be published; students cannot see a draft", async () => {
      const draft = await assignment({ title: "No rubric", rubric: undefined }, sec, false);
      expect((await teacher().post(`/api/sections/${sec}/assignments/${draft}/publish`, { published: true })).status).toBe(409);
      expect((await teacher().put(`/api/sections/${sec}/assignments/${draft}/rubric`, { items: rubric })).status).toBe(200);
      expect((await as("st1").get(`/api/portal/assignments/${draft}`)).status).toBe(404);
      expect((await as("st1").get("/api/portal/assignments")).body.map((x: { id: string }) => x.id)).not.toContain(draft);
      expect((await teacher().post(`/api/sections/${sec}/assignments/${draft}/publish`, { published: true })).status).toBe(201);
      expect((await as("st1").get(`/api/portal/assignments/${draft}`)).status).toBe(200);
      expect((await teacher().put(`/api/sections/${sec}/assignments/${draft}/rubric`, { items: [] })).status).toBe(409); // 已发布不能没有评分标准
    });

    it("only the section's instructors may author; the registrar may look, other teachers see nothing, students are not staff", async () => {
      const id = await assignment({ title: "Authoring rights" });
      expect((await registrar().get(`/api/sections/${sec}/assignments`)).status).toBe(200);
      expect((await registrar().post(`/api/sections/${sec}/assignments`, { title: "x", dueDate: iso(2) })).status).toBe(403); // 没有编辑权限
      expect((await registrar().patch(`/api/sections/${sec}/assignments/${id}`, { title: "x" })).status).toBe(403);
      expect((await other().get(`/api/sections/${sec}/assignments`)).status).toBe(404); // 不是任课教师：连班级都看不到
      expect((await other().post(`/api/sections/${sec}/assignments`, { title: "x", dueDate: iso(2) })).status).toBe(404);
      expect((await as("st1").get(`/api/sections/${sec}/assignments`)).status).toBe(403);
      expect((await teacher().patch(`/api/sections/${sec}/assignments/${id}`, { title: "Renamed" })).body.title).toBe("Renamed");
    });

    it("an assignment with submissions cannot be deleted or un-published; the rubric is frozen once scoring starts", async () => {
      const id = await assignment({ title: "Frozen" });
      expect((await as("st1").post(`/api/portal/assignments/${id}/submissions`, { text: "answer" })).status).toBe(201);
      expect((await teacher().del(`/api/sections/${sec}/assignments/${id}`)).status).toBe(409);
      expect((await teacher().post(`/api/sections/${sec}/assignments/${id}/publish`, { published: false })).status).toBe(409);
      const sub = (await teacher().get(`/api/sections/${sec}/assignments/${id}/submissions`)).body.rows.find((r: { fullName: string }) => r.fullName === "st1");
      expect((await teacher().put(`/api/sections/${sec}/assignments/${id}/rubric`, { items: [{ title: "New", maxPoints: 3 }] })).status).toBe(200); // 还没打分，可以改
      const items = (await teacher().get(`/api/sections/${sec}/assignments/${id}`)).body.rubric;
      expect((await teacher().put(`/api/sections/${sec}/assignments/${id}/submissions/${sub.submissionId}/grade`, { scores: [{ rubricItemId: items[0].id, points: 2 }] })).status).toBe(200);
      expect((await teacher().put(`/api/sections/${sec}/assignments/${id}/rubric`, { items: rubric })).status).toBe(409);
      expect((await teacher().patch(`/api/sections/${sec}/assignments/${id}`, { dueDate: iso(9) })).status).toBe(409); // 开始批改后截止时间也冻结
    });
  });

  describe("files: presigned direct upload", () => {
    let id: string;
    beforeAll(async () => {
      id = await assignment({ title: "Uploads" });
    });

    it("uploads to the object store with a presigned URL and confirms on submit; the teacher downloads the same bytes", async () => {
      const bytes = Buffer.from("print('hello from s1')\n");
      const fileId = await upload("st1", id, "hello.py", bytes);
      const row = await h.owner.submissionFile.findUniqueOrThrow({ where: { id: fileId } });
      expect(row.storageKey.startsWith(tenantPrefix(h.tenant.tenantId))).toBe(true); // 键以 tenant/<id>/ 开头
      const res = await as("st1").post(`/api/portal/assignments/${id}/submissions`, { text: "see file", fileIds: [fileId] });
      expect(res.status).toBe(201);
      const rows = (await teacher().get(`/api/sections/${sec}/assignments/${id}/submissions`)).body.rows;
      const mine = rows.find((r: { fullName: string }) => r.fullName === "st1");
      const detail = (await teacher().get(`/api/sections/${sec}/assignments/${id}/submissions/${mine.submissionId}`)).body;
      const file = detail.versions[0].files[0];
      expect(file).toMatchObject({ fileName: "hello.py", size: bytes.length });
      const download = await fetch(file.downloadUrl);
      expect(download.status).toBe(200);
      expect(Buffer.from(await download.arrayBuffer()).equals(bytes)).toBe(true);
    });

    it("refuses types that are not allowed, empty files and files above the size limit — before anything is stored", async () => {
      const ask = (body: object) => as("st2").post(`/api/portal/assignments/${id}/uploads`, { contentType: "application/octet-stream", ...body });
      expect((await ask({ fileName: "virus.exe", size: 100 })).status).toBe(400);
      expect((await ask({ fileName: "noextension", size: 100 })).status).toBe(400);
      expect((await ask({ fileName: "empty.txt", size: 0 })).status).toBe(400);
      expect((await ask({ fileName: "huge.zip", size: 21 * 1024 * 1024 })).status).toBe(400);
      expect((await ask({ fileName: "ok.zip", size: 20 * 1024 * 1024 })).status).toBe(201);
      expect(await h.owner.submissionFile.count({ where: { studentPersonId: pid("st2"), fileName: { in: ["virus.exe", "huge.zip"] } } })).toBe(0);
    });

    it("a file that was never uploaded, or whose size differs from the declaration, cannot be submitted", async () => {
      const never = (await as("st2").post(`/api/portal/assignments/${id}/uploads`, { fileName: "never.txt", contentType: "text/plain", size: 10 })).body;
      const miss = await as("st2").post(`/api/portal/assignments/${id}/submissions`, { fileIds: [never.fileId] });
      expect(miss.status).toBe(400);
      expect(miss.body.message).toMatch(/not uploaded/);
      const wrong = (await as("st2").post(`/api/portal/assignments/${id}/uploads`, { fileName: "wrong.txt", contentType: "text/plain", size: 10 })).body;
      await fetch(wrong.uploadUrl, { method: "PUT", headers: wrong.headers, body: Buffer.from("twelve bytes") }); // 存储可能直接拒绝，也可能收下
      expect((await as("st2").post(`/api/portal/assignments/${id}/submissions`, { fileIds: [wrong.fileId] })).status).toBe(400);
      expect(await h.owner.submission.count({ where: { assignmentId: id, studentPersonId: pid("st2") } })).toBe(0);
    });

    it("a student cannot attach someone else's upload, and the same upload cannot be used twice", async () => {
      const mine = await upload("st3", id, "mine.txt", Buffer.from("mine"));
      expect((await as("st2").post(`/api/portal/assignments/${id}/submissions`, { fileIds: [mine] })).status).toBe(400);
      expect((await as("st3").post(`/api/portal/assignments/${id}/submissions`, { fileIds: [mine] })).status).toBe(201);
      expect((await as("st3").post(`/api/portal/assignments/${id}/submissions`, { fileIds: [mine] })).status).toBe(400);
    });

    it("storage keys must lie under the tenant's own prefix — in the code and in the database", async () => {
      expect(() => assertTenantKey(h.tenant.tenantId, `tenant/${h.tenant.tenantId}/submissions/a/b/c.txt`)).not.toThrow();
      expect(() => assertTenantKey(h.tenant.tenantId, "tenant/11111111-1111-4111-8111-111111111111/submissions/a.txt")).toThrow();
      expect(() => assertTenantKey(h.tenant.tenantId, `tenant/${h.tenant.tenantId}/../other/a.txt`)).toThrow();
      await expect(
        h.owner.submissionFile.create({ data: { tenantId: h.tenant.tenantId, assignmentId: id, studentPersonId: pid("st1"), storageKey: "tenant/11111111-1111-4111-8111-111111111111/x.txt", fileName: "x.txt", contentType: "text/plain", size: 1 } }),
      ).rejects.toThrow(/submission_file_key_prefix_check/);
    });
  });

  describe("deadline and late work", () => {
    it("before the deadline: on time, resubmit as often as you like, the last one counts and history is kept", async () => {
      const id = await assignment({ title: "On time" });
      const first = await as("st1").post(`/api/portal/assignments/${id}/submissions`, { text: "v1" });
      expect(first.body).toMatchObject({ version: 1, isLate: false, latePenaltyPct: 0 });
      const second = await as("st1").post(`/api/portal/assignments/${id}/submissions`, { text: "v2" });
      expect(second.body).toMatchObject({ version: 2, isLate: false });
      const mine = (await as("st1").get(`/api/portal/assignments/${id}`)).body;
      expect(mine.submission.currentVersion).toBe(2);
      expect(mine.submission.versions.map((v: { textAnswer: string }) => v.textAnswer)).toEqual(["v1", "v2"]);
      expect(await h.owner.submission.count({ where: { assignmentId: id } })).toBe(1); // 一个学生一条提交
      expect((await as("st1").post(`/api/portal/assignments/${id}/submissions`, {})).status).toBe(400); // 文本和文件至少要有一样
    });

    it("after the deadline a resubmission counts as late; the penalty follows the table", async () => {
      const id = await assignment({ title: "Turns late" });
      expect((await as("st1").post(`/api/portal/assignments/${id}/submissions`, { text: "early" })).body.isLate).toBe(false);
      await setDue(id, -5); // 过期 5 小时
      const again = await as("st1").post(`/api/portal/assignments/${id}/submissions`, { text: "after deadline" });
      expect(again.body).toMatchObject({ version: 2, isLate: true, latePenaltyPct: 10 });
      expect(again.body.hoursLate).toBeGreaterThan(4.9);
      expect(again.body.hoursLate).toBeLessThan(5.1);
      const versions = (await as("st1").get(`/api/portal/assignments/${id}`)).body.submission.versions;
      expect(versions.map((v: { isLate: boolean }) => v.isLate)).toEqual([false, true]);
    });

    it.each([[-5, 10], [-30, 20], [-60, 30], [-80, 100]])("%d hours from the deadline → %d%% off", async (hours, pct) => {
      const id = await assignment({ title: `Late ${hours}` });
      await setDue(id, hours);
      const res = await as("st2").post(`/api/portal/assignments/${id}/submissions`, { text: "late" });
      expect(res.status).toBe(201);
      expect(res.body.latePenaltyPct).toBe(pct);
    });

    it("an assignment that does not accept late work refuses it after the deadline", async () => {
      const id = await assignment({ title: "Strict", allowLate: false });
      await setDue(id, -1);
      expect((await as("st3").post(`/api/portal/assignments/${id}/submissions`, { text: "late" })).status).toBe(409);
      expect((await as("st3").post(`/api/portal/assignments/${id}/uploads`, { fileName: "a.txt", contentType: "text/plain", size: 5 })).status).toBe(409);
      expect((await as("st3").get(`/api/portal/assignments/${id}`)).body.canSubmit).toBe(false);
    });

    it("a custom late table is used; changing the deadline re-computes ungraded submissions", async () => {
      const id = await assignment({ title: "Custom", latePolicy: { tiers: [{ upToHours: 12, pct: 5 }], beyondPct: 50 } });
      await setDue(id, -5);
      expect((await as("st1").post(`/api/portal/assignments/${id}/submissions`, { text: "x" })).body.latePenaltyPct).toBe(5);
      expect((await teacher().patch(`/api/sections/${sec}/assignments/${id}`, { dueDate: iso(5) })).status).toBe(200); // 截止日推后 → 不再迟交
      const row = (await teacher().get(`/api/sections/${sec}/assignments/${id}/submissions`)).body.rows.find((r: { fullName: string }) => r.fullName === "st1");
      expect(row).toMatchObject({ isLate: false, latePenaltyPct: 0 });
    });
  });

  describe("extensions", () => {
    it("an extension of 1–3 days moves one student's deadline; others are unaffected; the reason and the person are recorded", async () => {
      const id = await assignment({ title: "Extension" });
      await setDue(id, -30); // 过期 30 小时：本来扣 20%
      const bad = (days: number, reason = "doctor's note") => teacher().put(`/api/sections/${sec}/assignments/${id}/extensions/${pid("st2")}`, { days, reason });
      expect((await bad(4)).status).toBe(400);
      expect((await bad(0)).status).toBe(400);
      expect((await bad(2, "x")).status).toBe(400); // 原因太短
      expect((await bad(2)).status).toBe(200);
      expect((await teacher().put(`/api/sections/${sec}/assignments/${id}/extensions/${pid("s.out")}`, { days: 1, reason: "not in the class" })).status).toBe(400);
      expect((await as("st2").post(`/api/portal/assignments/${id}/submissions`, { text: "with extension" })).body).toMatchObject({ isLate: false, latePenaltyPct: 0 });
      expect((await as("st3").post(`/api/portal/assignments/${id}/submissions`, { text: "no extension" })).body).toMatchObject({ isLate: true, latePenaltyPct: 20 });
      const row = (await teacher().get(`/api/sections/${sec}/assignments/${id}/submissions`)).body.rows.find((r: { fullName: string }) => r.fullName === "st2");
      expect(row.extension).toEqual({ days: 2, reason: "doctor's note" });
      const logs = (await audit().get("/api/audit-logs?size=100")).body as Array<{ action: string; actorId?: string; detail?: { days?: number } }>;
      expect(logs.some((l) => l.action === "assignment.extend")).toBe(true);
    });

    it("the registrar may grant one too; granting after the fact re-computes the late submission; it cannot change once grading started", async () => {
      const id = await assignment({ title: "Late then extended" });
      await setDue(id, -30);
      expect((await as("st3").post(`/api/portal/assignments/${id}/submissions`, { text: "late" })).body.latePenaltyPct).toBe(20);
      expect((await registrar().put(`/api/sections/${sec}/assignments/${id}/extensions/${pid("st3")}`, { days: 3, reason: "family emergency" })).status).toBe(200);
      let row = (await teacher().get(`/api/sections/${sec}/assignments/${id}/submissions`)).body.rows.find((r: { fullName: string }) => r.fullName === "st3");
      expect(row).toMatchObject({ isLate: false, latePenaltyPct: 0 });
      expect((await registrar().del(`/api/sections/${sec}/assignments/${id}/extensions/${pid("st3")}`)).status).toBe(200);
      row = (await teacher().get(`/api/sections/${sec}/assignments/${id}/submissions`)).body.rows.find((r: { fullName: string }) => r.fullName === "st3");
      expect(row).toMatchObject({ isLate: true, latePenaltyPct: 20 });
      const items = (await teacher().get(`/api/sections/${sec}/assignments/${id}`)).body.rubric;
      await teacher().put(`/api/sections/${sec}/assignments/${id}/submissions/${row.submissionId}/grade`, { scores: [{ rubricItemId: items[0].id, points: 1 }] });
      expect((await teacher().put(`/api/sections/${sec}/assignments/${id}/extensions/${pid("st3")}`, { days: 1, reason: "too late now" })).status).toBe(409);
    });

    it("other teachers cannot grant extensions in a section they do not teach; students cannot at all", async () => {
      const id = await assignment({ title: "Not yours" });
      expect((await other().put(`/api/sections/${sec}/assignments/${id}/extensions/${pid("st1")}`, { days: 1, reason: "no right" })).status).toBe(404);
      expect((await as("st1").put(`/api/sections/${sec}/assignments/${id}/extensions/${pid("st1")}`, { days: 1, reason: "no right" })).status).toBe(403);
    });
  });

  describe("grading and publishing", () => {
    it("scores rubric items one by one (never above the item maximum); the raw score is their sum", async () => {
      const id = await assignment({ title: "Grade me" });
      await as("st1").post(`/api/portal/assignments/${id}/submissions`, { text: "answer" });
      const rows = (await teacher().get(`/api/sections/${sec}/assignments/${id}/submissions`)).body.rows;
      expect(rows.map((r: { status: string }) => r.status).sort()).toEqual(["missing", "missing", "missing", "submitted"]); // 班里 4 个学生，没交的也在名单上
      const sub = rows.find((r: { status: string }) => r.status === "submitted").submissionId;
      const items = (await teacher().get(`/api/sections/${sec}/assignments/${id}`)).body.rubric;
      const grade = (body: object) => teacher().put(`/api/sections/${sec}/assignments/${id}/submissions/${sub}/grade`, body);
      expect((await grade({ scores: [{ rubricItemId: items[0].id, points: 7 }] })).status).toBe(400); // 超过该项满分 6
      expect((await grade({ scores: [{ rubricItemId: "11111111-1111-4111-8111-111111111111", points: 1 }] })).status).toBe(400);
      expect((await grade({ scores: [{ rubricItemId: items[0].id, points: 1 }, { rubricItemId: items[0].id, points: 2 }] })).status).toBe(400);
      const partial = await grade({ scores: [{ rubricItemId: items[0].id, points: 5, comment: "good" }], feedback: "so far" });
      expect(partial.body).toMatchObject({ status: "grading", rawScore: 5, finalScore: 5 });
      expect((await as("st1").post(`/api/portal/assignments/${id}/submissions`, { text: "change" })).status).toBe(409); // 批改中不能再交
      expect((await teacher().post(`/api/sections/${sec}/assignments/${id}/submissions/${sub}/publish`)).status).toBe(409); // 还有一项没打
      const whole = await grade({ scores: [{ rubricItemId: items[0].id, points: 5 }, { rubricItemId: items[1].id, points: 4 }] });
      expect(whole.body).toMatchObject({ rawScore: 9, finalScore: 9 });
    });

    it("the student sees only the status until the score is published; then the breakdown", async () => {
      const id = await assignment({ title: "Publish me" });
      await as("st2").post(`/api/portal/assignments/${id}/submissions`, { text: "answer" });
      const sub = (await teacher().get(`/api/sections/${sec}/assignments/${id}/submissions`)).body.rows.find((r: { fullName: string }) => r.fullName === "st2").submissionId;
      const items = (await teacher().get(`/api/sections/${sec}/assignments/${id}`)).body.rubric;
      await teacher().put(`/api/sections/${sec}/assignments/${id}/submissions/${sub}/grade`, { scores: items.map((i: { id: string; maxPoints: number }) => ({ rubricItemId: i.id, points: i.maxPoints })), feedback: "well done" });
      let view = (await as("st2").get(`/api/portal/assignments/${id}`)).body;
      expect(view.submission.status).toBe("grading");
      expect(view.submission.result).toBeNull();
      expect((await as("st2").get("/api/portal/assignments")).body.find((x: { id: string }) => x.id === id).finalScore).toBeNull();
      expect((await teacher().post(`/api/sections/${sec}/assignments/${id}/submissions/${sub}/publish`)).status).toBe(201);
      view = (await as("st2").get(`/api/portal/assignments/${id}`)).body;
      expect(view.submission.status).toBe("published");
      expect(view.submission.result).toMatchObject({ rawScore: 10, finalScore: 10, feedback: "well done" });
      expect(view.submission.result.scores).toHaveLength(2);
      expect((await as("st2").get("/api/portal/assignments")).body.find((x: { id: string }) => x.id === id).finalScore).toBe(10);
      // 发布后不能再改
      expect((await teacher().put(`/api/sections/${sec}/assignments/${id}/submissions/${sub}/grade`, { scores: [] })).status).toBe(409);
      expect((await teacher().post(`/api/sections/${sec}/assignments/${id}/submissions/${sub}/publish`)).status).toBe(409);
      expect((await as("st2").post(`/api/portal/assignments/${id}/submissions`, { text: "again" })).status).toBe(409);
      expect(await h.owner.outboxEvent.count({ where: { tenantId: h.tenant.tenantId, type: "submission.published" } })).toBeGreaterThan(0);
    });

    it("a late submission is scored by the table: 8 points, 10% off → 7 (whole points, half to even)", async () => {
      const id = await assignment({ title: "Late grading" });
      await setDue(id, -5);
      await as("st3").post(`/api/portal/assignments/${id}/submissions`, { text: "late" });
      const sub = (await teacher().get(`/api/sections/${sec}/assignments/${id}/submissions`)).body.rows.find((r: { fullName: string }) => r.fullName === "st3").submissionId;
      const items = (await teacher().get(`/api/sections/${sec}/assignments/${id}`)).body.rubric;
      const res = await teacher().put(`/api/sections/${sec}/assignments/${id}/submissions/${sub}/grade`, { scores: [{ rubricItemId: items[0].id, points: 4 }, { rubricItemId: items[1].id, points: 4 }] });
      expect(res.body).toMatchObject({ rawScore: 8, latePenaltyPct: 10, finalScore: 7 });
      await teacher().post(`/api/sections/${sec}/assignments/${id}/submissions/${sub}/publish`);
      const view = (await as("st3").get(`/api/portal/assignments/${id}`)).body.submission.result;
      expect(view).toMatchObject({ rawScore: 8, latePenaltyPct: 10, finalScore: 7 });
    });

    it("publish-all releases the fully scored ones and leaves the rest", async () => {
      const id = await assignment({ title: "Bulk" });
      for (const n of ["st1", "st2", "st3"]) await as(n).post(`/api/portal/assignments/${id}/submissions`, { text: n });
      const items = (await teacher().get(`/api/sections/${sec}/assignments/${id}`)).body.rubric;
      const rows = (await teacher().get(`/api/sections/${sec}/assignments/${id}/submissions`)).body.rows.filter((r: { submissionId: string | null }) => r.submissionId);
      for (const [i, r] of rows.entries()) {
        const scores = i === 0 ? [{ rubricItemId: items[0].id, points: 1 }] : items.map((x: { id: string }) => ({ rubricItemId: x.id, points: 1 }));
        await teacher().put(`/api/sections/${sec}/assignments/${id}/submissions/${r.submissionId}/grade`, { scores });
      }
      expect((await teacher().post(`/api/sections/${sec}/assignments/${id}/publish-grades`)).body).toEqual({ published: 2, notReady: 1 });
    });

    it("only the section's instructors grade: not the registrar, not another teacher, not a student", async () => {
      const id = await assignment({ title: "Who grades" });
      await as("st1").post(`/api/portal/assignments/${id}/submissions`, { text: "answer" });
      const sub = (await teacher().get(`/api/sections/${sec}/assignments/${id}/submissions`)).body.rows.find((r: { submissionId: string | null }) => r.submissionId).submissionId;
      const path = `/api/sections/${sec}/assignments/${id}/submissions/${sub}/grade`;
      expect((await registrar().put(path, { scores: [] })).status).toBe(403);
      expect((await other().put(path, { scores: [] })).status).toBe(404);
      expect((await as("st1").put(path, { scores: [] })).status).toBe(403);
      expect((await registrar().get(`/api/sections/${sec}/assignments/${id}/submissions/${sub}`)).status).toBe(200); // 教务可以看
      expect((await other().get(`/api/sections/${sec}/assignments/${id}/submissions/${sub}`)).status).toBe(404);
    });
  });

  describe("the student side: who may see and submit", () => {
    let id: string;
    beforeAll(async () => {
      id = await assignment({ title: "Visibility" });
    });

    it("a student sees only the assignments of sections they are in; another student's submission is never visible", async () => {
      expect((await as("s.out").get("/api/portal/assignments")).body).toEqual([]);
      expect((await as("s.out").get(`/api/portal/assignments/${id}`)).status).toBe(404);
      expect((await as("s.out").post(`/api/portal/assignments/${id}/submissions`, { text: "x" })).status).toBe(404);
      await as("st1").post(`/api/portal/assignments/${id}/submissions`, { text: "secret answer" });
      const theirs = (await as("st2").get(`/api/portal/assignments/${id}`)).body;
      expect(theirs.submission).toBeNull();
      expect(JSON.stringify(theirs)).not.toContain("secret answer");
    });

    it("a student on leave can read but not submit; graduated students cannot see class content", async () => {
      expect((await as("s.leave").get(`/api/portal/assignments/${id}`)).status).toBe(200);
      await h.owner.studentProfile.updateMany({ where: { personId: pid("s.leave") }, data: { academicStatus: "on_leave" } });
      expect((await as("s.leave").get(`/api/portal/assignments/${id}`)).body.canSubmit).toBe(false);
      expect((await as("s.leave").post(`/api/portal/assignments/${id}/submissions`, { text: "x" })).status).toBe(403);
      await h.owner.studentProfile.updateMany({ where: { personId: pid("s.leave") }, data: { academicStatus: "graduated" } });
      expect((await as("s.leave").get("/api/portal/assignments")).status).toBe(403);
      await h.owner.studentProfile.updateMany({ where: { personId: pid("s.leave") }, data: { academicStatus: "enrolled" } });
    });

    it("staff accounts are not students: the portal area refuses them", async () => {
      expect((await teacher().get("/api/portal/assignments")).status).toBe(403);
    });
  });

  describe("when the section is over", () => {
    it("assignments, submissions and grades are read-only once the section has ended", async () => {
      const other202 = (await registrar().post("/api/courses", { code: "CS202", name: "Other", credits: 3 })).body.id;
      const ended = await mkSection("90", ["st1"], other202);
      const id = await assignment({ title: "Before the end" }, ended);
      await as("st1").post(`/api/portal/assignments/${id}/submissions`, { text: "answer" });
      const sub = (await teacher().get(`/api/sections/${ended}/assignments/${id}/submissions`)).body.rows[0].submissionId;
      const items = (await teacher().get(`/api/sections/${ended}/assignments/${id}`)).body.rubric;
      await h.owner.section.update({ where: { id: ended }, data: { status: "ended" } });
      expect((await teacher().put(`/api/sections/${ended}/assignments/${id}/submissions/${sub}/grade`, { scores: [{ rubricItemId: items[0].id, points: 1 }] })).status).toBe(409);
      expect((await teacher().post(`/api/sections/${ended}/assignments`, { title: "x", dueDate: iso(2) })).status).toBe(409);
      expect((await as("st1").post(`/api/portal/assignments/${id}/submissions`, { text: "too late" })).status).toBe(409);
      expect((await teacher().get(`/api/sections/${ended}/assignments/${id}/submissions/${sub}`)).status).toBe(200); // 仍可查看
    });
  });
});
