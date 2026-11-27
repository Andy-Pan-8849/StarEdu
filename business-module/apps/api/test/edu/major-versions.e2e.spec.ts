// 培养方案版本：版本按入学年份生效；学生用入学年份落在的版本的课程设置和学分要求；
// 新增版本复制当前版本，之后各改各的；删除版本后学生落到前一个版本；至少保留一个版本。
import { Harness } from "../helpers/app";

describe("curriculum versions", () => {
  const h = new Harness();
  let reg: string;
  let major: string;
  let c1: string;
  let c2: string;
  let c3: string;
  const registrar = () => h.call(reg);

  async function student(name: string) {
    const u = await h.user(name, { roles: ["student"], person: "student" });
    return { u, token: await u.token() };
  }
  const plan = async (token: string) => (await h.call(token).get("/api/portal/plan")).body;

  beforeAll(async () => {
    await h.start();
    reg = await (await h.user("registrar", { roles: ["academic-manager"], person: "staff" })).token();
    const mk = async (code: string) => (await registrar().post("/api/courses", { code, name: code, credits: 3 })).body.id as string;
    c1 = await mk("V101");
    c2 = await mk("V102");
    c3 = await mk("V103");
    major = (await registrar().post("/api/majors", { code: "VM", name: "Versioned", totalCredits: 9 })).body.id;
    await registrar().put(`/api/majors/${major}/courses`, { items: [{ courseId: c1, category: "required" }, { courseId: c2, category: "elective" }] });
  });
  afterAll(() => h.stop());

  it("a new major starts with one version holding its curriculum and credits", async () => {
    const m = (await registrar().get(`/api/majors/${major}`)).body;
    expect(m.versions).toHaveLength(1);
    expect(m.versions[0]).toMatchObject({ label: "Initial", effectiveYear: 2000, totalCredits: 9, courseCount: 2, entryYearFrom: null, entryYearTo: null });
    expect(m.courses.map((c: { code: string }) => c.code).sort()).toEqual(["V101", "V102"]);
  });

  it("adding a version copies the current one; edits to each stay separate; credits mirror the latest on the major", async () => {
    const created = await registrar().post(`/api/majors/${major}/versions`, { effectiveYear: 2026, label: "2026 plan" });
    expect(created.status).toBe(201);
    expect(created.body.copied).toBe(2);
    const v2 = created.body.id as string;
    expect((await registrar().post(`/api/majors/${major}/versions`, { effectiveYear: 2026 })).status).toBe(409); // 同一年只能有一个
    expect((await registrar().post(`/api/majors/${major}/versions`, { effectiveYear: 1800 })).status).toBe(400);
    expect((await registrar().put(`/api/majors/${major}/courses?version=${v2}`, { items: [{ courseId: c1, category: "required" }, { courseId: c3, category: "required" }] })).status).toBe(200);
    expect((await registrar().patch(`/api/majors/${major}/versions/${v2}`, { totalCredits: 12, electiveMinCredits: 3 })).status).toBe(200);

    const detail = (await registrar().get(`/api/majors/${major}`)).body; // 默认最新版本
    expect(detail.versionId).toBe(v2);
    expect(detail.courses.map((c: { code: string }) => c.code).sort()).toEqual(["V101", "V103"]);
    expect(detail.versions.map((v: { label: string; entryYearFrom: number | null; entryYearTo: number | null }) => [v.label, v.entryYearFrom, v.entryYearTo])).toEqual([["Initial", null, 2025], ["2026 plan", 2026, null]]);
    const first = detail.versions[0].id as string;
    const old = (await registrar().get(`/api/majors/${major}?version=${first}`)).body;
    expect(old.courses.map((c: { code: string }) => c.code).sort()).toEqual(["V101", "V102"]);
    expect(old.totalCredits).toBe(9);
    // 专业列表和专业上的学分镜像最新版本
    expect((await registrar().get("/api/majors")).body.find((m: { id: string }) => m.id === major).totalCredits).toBe(12);
    // 课程上看到的专业不会因为多个版本重复出现
    expect((await registrar().get(`/api/courses/${c1}`)).body.majors).toHaveLength(1);
    expect((await registrar().get(`/api/majors/${major}?version=11111111-1111-4111-8111-111111111111`)).status).toBe(404);
  });

  it("each student follows the version of their entry year in the portal plan", async () => {
    const early = await student("entry.early");
    const late = await student("entry.late");
    expect((await registrar().put(`/api/majors/${major}/students/${early.u.personId}`, { kind: "primary", entryYear: 2024 })).status).toBe(200);
    expect((await registrar().put(`/api/majors/${major}/students/${late.u.personId}`, { kind: "primary", entryYear: 2026 })).status).toBe(200);
    const a = await plan(early.token);
    const b = await plan(late.token);
    expect(a.selected.version).toMatchObject({ label: "Initial" });
    expect(a.courses.map((c: { code: string }) => c.code).sort()).toEqual(["V101", "V102"]);
    expect(a.credits.required).toBe(9);
    expect(b.selected.version).toMatchObject({ label: "2026 plan" });
    expect(b.courses.map((c: { code: string }) => c.code).sort()).toEqual(["V101", "V103"]);
    expect(b.credits.required).toBe(12);
    const roster = (await registrar().get(`/api/majors/${major}/students`)).body;
    expect(roster.find((r: { id: string }) => r.id === late.u.personId)).toMatchObject({ entryYear: 2026, versionLabel: "2026 plan" });
    expect(roster.find((r: { id: string }) => r.id === early.u.personId)).toMatchObject({ entryYear: 2024, versionLabel: "Initial" });
  });

  it("without an entry year the declaration year is used; changing the curriculum of one version leaves the other students alone", async () => {
    const s = await student("entry.default");
    await registrar().put(`/api/majors/${major}/students/${s.u.personId}`, { kind: "primary" });
    const year = new Date().getUTCFullYear();
    expect(((await registrar().get(`/api/majors/${major}/students`)).body as Array<{ id: string; entryYear: number }>).find((r) => r.id === s.u.personId)?.entryYear).toBe(year);
    const first = (await registrar().get(`/api/majors/${major}`)).body.versions[0].id as string;
    await registrar().put(`/api/majors/${major}/courses?version=${first}`, { items: [{ courseId: c1, category: "required" }] });
    const early = (await registrar().get(`/api/majors/${major}/students`)).body.find((r: { entryYear: number }) => r.entryYear === 2024);
    expect(early.versionLabel).toBe("Initial");
    const late = (await registrar().get(`/api/majors/${major}`)).body; // 最新版本没动
    expect(late.courses).toHaveLength(2);
  });

  it("removing a version moves its students to the previous one; the last version cannot be removed", async () => {
    const versions = (await registrar().get(`/api/majors/${major}`)).body.versions as Array<{ id: string; label: string }>;
    const first = versions[0]!;
    const second = versions[1]!;
    expect((await registrar().del(`/api/majors/${major}/versions/${second.id}`)).status).toBe(200);
    const roster = (await registrar().get(`/api/majors/${major}/students`)).body as Array<{ versionLabel: string }>;
    expect(roster.every((r) => r.versionLabel === "Initial")).toBe(true);
    expect(await h.owner.majorCourse.count({ where: { versionId: second.id } })).toBe(0);
    expect((await registrar().del(`/api/majors/${major}/versions/${first.id}`)).status).toBe(409);
    // 专业上的学分回到剩下那个版本
    expect((await registrar().get("/api/majors")).body.find((m: { id: string }) => m.id === major).totalCredits).toBe(9);
  });

  it("needs the major permissions", async () => {
    const stu = (await student("no.perm")).token;
    expect((await h.call(stu).post(`/api/majors/${major}/versions`, { effectiveYear: 2030 })).status).toBe(403);
  });
});
