// 班级讨论：谁能读、谁能写、置顶、已解决、删除、通知相关的人、班级结课后只读。
import { NotifyWorker } from "../../src/notify/notify-worker";
import { Harness, type TestUser } from "../helpers/app";

const iso = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

describe("class discussion", () => {
  const h = new Harness();
  let worker: NotifyWorker;
  let termId: string;
  let hqCampus: string;
  let hqDept: string;
  let sec: string;
  let reg: string;
  let t1: string;
  let t2: string;
  let teacher1: TestUser;
  const stu: Record<string, { u: TestUser; token: string }> = {};
  const as = (n: string) => h.call(stu[n].token);
  const pid = (n: string) => stu[n].u.personId as string;
  const registrar = () => h.call(reg);
  const teacher = () => h.call(t1);
  const other = () => h.call(t2);
  const d = (s = sec) => `/api/sections/${s}/discussions`;
  const pd = (s = sec) => `/api/portal/sections/${s}/discussions`;
  const inbox = async (n: string) => ((await as(n).get("/api/portal/notifications")).body.items as Array<{ title: string; category: string }>).map((i) => i.title);

  async function student(name: string, status?: "enrolled" | "on_leave" | "graduated") {
    const u = await h.user(name, { roles: ["student"], person: "student", studentStatus: status });
    stu[name] = { u, token: await u.token() };
  }

  beforeAll(async () => {
    await h.start();
    worker = h.app.get(NotifyWorker);
    const campus = await h.owner.campus.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, type: "hq" } });
    hqCampus = campus.id;
    hqDept = campus.deptId;
    reg = await (await h.user("registrar", { roles: ["academic-manager"], person: "staff", deptIds: [hqDept] })).token();
    teacher1 = await h.user("teacher.one", { roles: ["teacher"], person: "staff", deptIds: [hqDept] });
    t1 = await teacher1.token();
    t2 = await (await h.user("teacher.two", { roles: ["teacher"], person: "staff", deptIds: [hqDept] })).token();
    for (const n of ["stu1", "stu2", "stu3", "stu.out"]) await student(n);
    await student("stu.leave");
    termId = (await registrar().post("/api/terms", { code: "2026F", name: "2026 Fall", startDate: iso(-10), endDate: iso(80), enrollOpenDate: iso(-5), enrollCloseDate: iso(10), dropDeadline: iso(20) })).body.id;
    await registrar().post(`/api/terms/${termId}/status`, { status: "enrolling" });
    const course = (await registrar().post("/api/courses", { code: "CS601", name: "Compilers", credits: 3 })).body.id;
    sec = (await registrar().post("/api/sections", { courseId: course, termId, campusId: hqCampus, number: "01", capacity: 20, schedule: [] })).body.id;
    await registrar().put(`/api/sections/${sec}/instructors`, { items: [{ personId: teacher1.personId, role: "lead" }] });
    await registrar().post(`/api/sections/${sec}/status`, { status: "open" });
    await registrar().post(`/api/sections/${sec}/enrollments`, { studentIds: ["stu1", "stu2", "stu3", "stu.leave"].map(pid) });
    await h.owner.studentProfile.updateMany({ where: { personId: pid("stu.leave") }, data: { academicStatus: "on_leave" } });
  });
  afterAll(() => h.stop());

  describe("posting and replying", () => {
    let thread: string;

    it("a student starts a discussion; an instructor and a classmate reply; the thread shows who is who", async () => {
      const res = await as("stu1").post(pd(), { title: "How do I build the parser?", body: "Stuck on step 2." });
      expect(res.status).toBe(201);
      thread = res.body.id;
      expect(res.body).toMatchObject({ title: "How do I build the parser?", author: { name: "stu1", role: "student" }, pinned: false, resolved: false, canResolve: true, canPin: false, canDelete: true });
      expect((await teacher().post(`${d()}/${thread}/replies`, { body: "Read chapter 3 first." })).body.replies[0].author).toMatchObject({ name: "teacher.one", role: "instructor" });
      const view = (await as("stu2").post(`${pd()}/${thread}/replies`, { body: "Same here." })).body;
      expect(view.replies.map((r: { body: string }) => r.body)).toEqual(["Read chapter 3 first.", "Same here."]);
      expect(view.canResolve).toBe(false); // 不是发帖人，也不是老师
      expect((await as("stu3").get(pd())).body[0]).toMatchObject({ id: thread, replyCount: 2 });
    });

    it("validates the text; replies cannot be replied to or pinned", async () => {
      expect((await as("stu1").post(pd(), { title: "", body: "x" })).status).toBe(400);
      expect((await as("stu1").post(pd(), { title: "x", body: "   " })).status).toBe(400);
      expect((await as("stu1").post(pd(), { title: "x".repeat(201), body: "y" })).status).toBe(400);
      expect((await as("stu1").post(`${pd()}/${thread}/replies`, { body: "y".repeat(5001) })).status).toBe(400);
      const replyId = (await as("stu1").get(`${pd()}/${thread}`)).body.replies[0].id;
      expect((await as("stu1").post(`${pd()}/${replyId}/replies`, { body: "reply to a reply" })).status).toBe(404);
      expect((await teacher().post(`${d()}/${replyId}/pin`, { pinned: true })).status).toBe(404);
      await expect(h.owner.discussionPost.create({ data: { tenantId: h.tenant.tenantId, sectionId: sec, parentId: thread, authorPersonId: pid("stu1"), body: "x", pinned: true } })).rejects.toThrow(/discussion_post_shape_check/);
    });

    it("pinned discussions come first; only an instructor pins", async () => {
      const second = (await as("stu2").post(pd(), { title: "Second thread", body: "later" })).body.id;
      expect((await as("stu1").get(pd())).body.map((t: { id: string }) => t.id)).toEqual([second, thread]); // 最新活动在前
      expect((await as("stu1").post(`${pd()}/${thread}/pin`, { pinned: true })).status).toBe(404); // 学生端没有置顶这个接口
      expect((await other().post(`${d()}/${thread}/pin`, { pinned: true })).status).toBe(404); // 别的老师连班级都看不到
      expect((await registrar().post(`${d()}/${thread}/pin`, { pinned: true })).status).toBe(403); // 教务没有写权限
      expect((await teacher().post(`${d()}/${thread}/pin`, { pinned: true })).body.pinned).toBe(true);
      expect((await as("stu1").get(pd())).body.map((t: { id: string }) => t.id)).toEqual([thread, second]);
    });

    it("the author or an instructor marks it solved; the author is told when someone else does", async () => {
      expect((await as("stu2").post(`${pd()}/${thread}/resolve`, { resolved: true })).status).toBe(403);
      expect((await teacher().post(`${d()}/${thread}/resolve`, { resolved: true })).body.resolved).toBe(true);
      expect((await teacher().post(`${d()}/${thread}/resolve`, { resolved: false })).body.resolved).toBe(false);
      expect((await as("stu1").post(`${pd()}/${thread}/resolve`, { resolved: true })).body.resolved).toBe(true); // 自己标记
    });
  });

  describe("who can read and who can write", () => {
    it("only people in the section see it; a student on leave reads but cannot write; staff outside the section see nothing", async () => {
      expect((await as("stu.out").get(pd())).status).toBe(404);
      expect((await as("stu.out").post(pd(), { title: "x", body: "y" })).status).toBe(404);
      expect((await as("stu.leave").get(pd())).status).toBe(200);
      const view = (await as("stu.leave").get(pd())).body[0];
      expect(view).toMatchObject({ canReply: false, canDelete: false });
      expect((await as("stu.leave").post(pd(), { title: "x", body: "y" })).status).toBe(403);
      expect((await other().get(d())).status).toBe(404);
      expect((await registrar().get(d())).status).toBe(200); // 教务能看
      expect((await as("stu1").get(d())).status).toBe(403); // 学生走门户的接口
      expect((await teacher().get("/api/portal/sections/" + sec + "/discussions")).status).toBe(403);
    });

    it("graduated students cannot see class content at all", async () => {
      await student("stu.grad", "graduated");
      expect((await as("stu.grad").get(pd())).status).toBe(403);
    });

    it("deleting: students delete their own, instructors delete any; a deleted thread disappears with its replies", async () => {
      const t = (await as("stu1").post(pd(), { title: "To delete", body: "x" })).body.id;
      const r = (await as("stu2").post(`${pd()}/${t}/replies`, { body: "reply by stu2" })).body.replies[0].id;
      expect((await as("stu3").del(`${pd()}/${r}`)).status).toBe(403);
      expect((await as("stu1").del(`${pd()}/${r}`)).status).toBe(403); // 发帖人也不能删别人的回复
      expect((await as("stu2").del(`${pd()}/${r}`)).status).toBe(200);
      expect((await as("stu1").get(`${pd()}/${t}`)).body.replies).toEqual([]);
      expect((await as("stu2").del(`${pd()}/${t}`)).status).toBe(403);
      expect((await teacher().del(`${d()}/${t}`)).status).toBe(200);
      expect((await as("stu1").get(`${pd()}/${t}`)).status).toBe(404);
      expect((await as("stu1").get(pd())).body.some((x: { id: string }) => x.id === t)).toBe(false);
    });
  });

  describe("notifications", () => {
    it("a new discussion tells the instructors; a reply tells the author and the instructors (never the writer); solved tells the author", async () => {
      const t = (await as("stu3").post(pd(), { title: "Notify test", body: "x" })).body.id;
      await as("stu1").post(`${pd()}/${t}/replies`, { body: "reply from stu1" });
      await teacher().post(`${d()}/${t}/resolve`, { resolved: true });
      await worker.tick();
      const teacherInbox = ((await teacher().get("/api/notifications")).body.items as Array<{ title: string }>).map((i) => i.title);
      expect(teacherInbox.some((x) => x.includes("New discussion") && x.includes("Notify test"))).toBe(true);
      expect(teacherInbox.some((x) => x.includes("New reply") && x.includes("Notify test"))).toBe(true);
      const author = await inbox("stu3");
      expect(author.some((x) => x.includes("New reply") && x.includes("Notify test"))).toBe(true);
      expect(author.some((x) => x.includes("Marked as solved") && x.includes("Notify test"))).toBe(true);
      expect(author.some((x) => x.includes("New discussion") && x.includes("Notify test"))).toBe(false); // 不通知自己
      expect((await inbox("stu1")).some((x) => x.includes("Notify test"))).toBe(false); // 回复的人自己不收通知
      expect((await inbox("stu2")).some((x) => x.includes("Notify test"))).toBe(false); // 无关的同学也不收
    });
  });

  describe("when the section is over", () => {
    it("the discussion stays readable but nobody can write, pin, resolve or delete", async () => {
      const t = (await as("stu1").post(pd(), { title: "Last words", body: "x" })).body.id;
      await h.owner.section.update({ where: { id: sec }, data: { status: "ended" } });
      await h.owner.enrollment.updateMany({ where: { sectionId: sec, status: "enrolled" }, data: { status: "completed" } });
      const view = (await as("stu1").get(`${pd()}/${t}`)).body;
      expect(view).toMatchObject({ title: "Last words", canReply: false, canDelete: false, canResolve: false });
      expect((await as("stu1").post(pd(), { title: "x", body: "y" })).status).toBe(409);
      expect((await as("stu1").post(`${pd()}/${t}/replies`, { body: "y" })).status).toBe(409);
      expect((await teacher().post(`${d()}/${t}/pin`, { pinned: true })).status).toBe(409);
      expect((await teacher().del(`${d()}/${t}`)).status).toBe(409);
      expect((await teacher().get(d())).status).toBe(200);
    });
  });
});
