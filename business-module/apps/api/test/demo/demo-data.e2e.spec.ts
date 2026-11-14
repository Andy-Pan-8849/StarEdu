// 演示数据（B13）：和 AI 样本是同一家公司；可重复运行；账号能真登录；文档库按级别放好且权限对。
// 用一个临时租户（开通时的总部校区代码是 HQ，样本的 BJ 映射到它）。
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { importSample } from "../../src/cli/import-sample";
import { seedDemo, DEMO_PASSWORD_DEFAULT } from "../../src/demo/demo-data";
import { parseCsvRecords } from "../../src/hr/csv";
import { ObjectStoreService } from "../../src/storage/object-store.service";
import { Harness } from "../helpers/app";

const SAMPLE = resolve(__dirname, "../../../../../ai-module/sample-data");
const csv = (f: string) => parseCsvRecords(readFileSync(resolve(SAMPLE, f), "utf8"));

describe("demo data", () => {
  const h = new Harness();
  const store = new ObjectStoreService();
  let first: Awaited<ReturnType<typeof seedDemo>>;
  const run = () =>
    seedDemo({ owner: h.owner, tenantCode: h.tenant.code, sampleDir: SAMPLE, keycloak: h.keycloak, putObject: (k, b, t) => store.put(k, b, t), emitLibraryEvents: true });

  beforeAll(async () => {
    await h.start();
    await importSample(h.app, h.tenant.code, resolve(SAMPLE, "structured"), () => undefined);
    first = await run();
    await h.bump();
  }, 240_000);
  afterAll(() => h.stop());

  it("teaching data is the sample's: every submission, with its scores", async () => {
    const rows = csv("structured/submissions.csv");
    expect(first.submissions).toBe(rows.length);
    expect(first.assignments).toBe(csv("structured/assignments.csv").length * (await h.owner.section.count({ where: { tenantId: h.tenant.tenantId } })) / 3);
    const persons = new Map((await h.owner.studentProfile.findMany({ where: { tenantId: h.tenant.tenantId } })).map((s) => [s.studentNo, s.personId]));
    const stored = await h.owner.submission.findMany({ where: { tenantId: h.tenant.tenantId }, include: { assignment: true } });
    for (const r of rows) {
      const hit = stored.find((s) => s.studentPersonId === persons.get(r.student_id) && s.assignment.description === `sample:${r.assignment_id}`);
      expect(hit).toBeDefined();
      expect(Number(hit?.rawScore)).toBe(Number(r.raw_score));
      expect(Number(hit?.finalScore)).toBe(Number(r.final_score));
      expect(Number(hit?.latePenaltyPct)).toBe(Number(r.late_penalty_pct));
    }
  });

  it("sections: one per program and campus, each with its lead instructor, ended with published final grades", async () => {
    const sections = await h.owner.section.findMany({ where: { tenantId: h.tenant.tenantId }, include: { instructors: true, enrollments: true } });
    expect(sections.length).toBeGreaterThan(3);
    for (const s of sections) {
      expect(s.status).toBe("ended");
      expect(s.instructors).toHaveLength(1);
    }
    const students = csv("structured/students.csv");
    const withdrawn = students.filter((s) => s.status === "withdrawn").length;
    expect(first.enrollments).toBe(students.length);
    expect(first.finalGrades).toBe(students.length - withdrawn);
    expect(await h.owner.finalGrade.count({ where: { tenantId: h.tenant.tenantId, publishedAt: null } })).toBe(0);
    expect(await h.owner.enrollment.count({ where: { tenantId: h.tenant.tenantId, status: "withdrawn" } })).toBe(withdrawn);
  });

  it("running it again adds nothing", async () => {
    const counts = async () => [
      await h.owner.section.count({ where: { tenantId: h.tenant.tenantId } }),
      await h.owner.assignment.count({ where: { tenantId: h.tenant.tenantId } }),
      await h.owner.submission.count({ where: { tenantId: h.tenant.tenantId } }),
      await h.owner.enrollment.count({ where: { tenantId: h.tenant.tenantId } }),
      await h.owner.finalGrade.count({ where: { tenantId: h.tenant.tenantId } }),
      await h.owner.account.count({ where: { tenantId: h.tenant.tenantId } }),
      await h.owner.docFolder.count({ where: { tenantId: h.tenant.tenantId } }),
      await h.owner.docFile.count({ where: { tenantId: h.tenant.tenantId } }),
      await h.owner.outboxEvent.count({ where: { tenantId: h.tenant.tenantId, type: "library.file_changed" } }),
    ];
    const before = await counts();
    await run();
    expect(await counts()).toEqual(before);
  }, 120_000);

  it("demo accounts: linked to the right person, roles from the mapping, and they really sign in", async () => {
    const wanted = csv("demo-accounts.csv");
    expect(first.accounts).toBe(wanted.length);
    const teacher = wanted.find((a) => a.username === "wei.acad.sh")!;
    const account = await h.owner.account.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, username: teacher.username }, include: { roles: { include: { role: true } }, person: { include: { staff: true } } } });
    expect(account.person?.staff?.employeeNo).toBe(teacher.subject_id);
    expect(account.roles.map((r) => r.role.code)).toEqual(["teacher"]);
    const res = await fetch(`${h.keycloak.url}/realms/${h.realm}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", client_id: "portal", username: teacher.username, password: DEMO_PASSWORD_DEFAULT }),
    });
    expect(res.status).toBe(200);
    const token = ((await res.json()) as { access_token: string }).access_token;
    const mine = await h.call(token).get("/api/portal/library/folders");
    expect([200, 403]).toContain(mine.status); // 教师角色没有门户文档库菜单时 403；这里只确认令牌被业务模块接受
    expect((await h.call(token).get("/api/library/folders")).status).toBe(200);
  });

  it("library: confidential folders are readable by the HR role only; public ones by everyone; the AI gets one event per file", async () => {
    const folders = await h.owner.docFolder.findMany({ where: { tenantId: h.tenant.tenantId } });
    const confidential = folders.filter((f) => f.classification === "confidential");
    expect(confidential.length).toBeGreaterThan(0);
    expect(confidential.every((f) => f.logAccess && !f.inheritAcl)).toBe(true);
    const hr = await h.call(await tokenOf("qing.hr.bj")).get("/api/library/folders");
    const teacher = await h.call(await tokenOf("wei.acad.sh")).get("/api/library/folders");
    const names = (r: { body: Array<{ name: string }> }) => r.body.map((f) => f.name);
    expect(names(hr as never).some((n) => /confidential/.test(n))).toBe(true);
    expect(names(teacher as never).some((n) => /confidential/.test(n))).toBe(false);
    const files = await h.owner.docFile.count({ where: { tenantId: h.tenant.tenantId } });
    expect(files).toBe(first.files);
    expect(await h.owner.outboxEvent.count({ where: { tenantId: h.tenant.tenantId, type: "library.file_changed" } })).toBe(files);
  });

  async function tokenOf(username: string): Promise<string> {
    const res = await fetch(`${h.keycloak.url}/realms/${h.realm}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", client_id: "portal", username, password: DEMO_PASSWORD_DEFAULT }),
    });
    return ((await res.json()) as { access_token: string }).access_token;
  }
});
