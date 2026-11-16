// 演示场景：只对带"演示"标记的公司运行；生成的数据相对运行当天、内容齐全；重复运行不增加记录；演示超级角色有全部管理菜单和全部数据范围。
import { MENU_CATALOG, entriesOf } from "@staredu/shared";
import { Harness } from "../helpers/app";
import { DEMO_ROLE, scenarioAccounts, seedScenario } from "../../src/demo/demo-scenario";

describe("demo scenario", () => {
  const h = new Harness();
  beforeAll(() => h.start());
  afterAll(() => h.stop());
  const run = () => seedScenario({ owner: h.owner, tenantCode: h.tenant.code, prefix: "demo" });
  const tenantId = () => h.tenant.tenantId;

  it("refuses a company that is not marked as a demo company", async () => {
    await expect(run()).rejects.toThrow(/not marked as a demo company/);
    expect(await h.owner.account.count({ where: { tenantId: tenantId(), username: "demo.admin" } })).toBe(0);
    expect(await h.owner.role.count({ where: { tenantId: tenantId(), code: DEMO_ROLE } })).toBe(0);
  });

  it("builds a living company relative to today", async () => {
    await h.owner.tenant.update({ where: { id: tenantId() }, data: { isDemo: true } });
    const r = await run();
    expect(r).toMatchObject({ terms: 3, accounts: 5 });
    const now = Date.now();
    const cur = await h.owner.term.findFirstOrThrow({ where: { tenantId: tenantId(), code: "DEMO-CUR" } });
    expect(cur.status).toBe("enrolling");
    expect(cur.startDate.getTime()).toBeLessThan(now);
    expect(cur.endDate.getTime()).toBeGreaterThan(now);
    expect(cur.enrollCloseDate!.getTime()).toBeGreaterThan(now); // 选课还没截止：学生现在就能选课
    expect(await h.owner.term.count({ where: { tenantId: tenantId(), status: "planned" } })).toBe(1);
    const assignments = await h.owner.assignment.findMany({ where: { tenantId: tenantId(), section: { termId: cur.id } } });
    expect(assignments.some((a) => a.published && a.dueAt.getTime() > now)).toBe(true); // 有没到期的
    expect(assignments.some((a) => a.dueAt.getTime() < now)).toBe(true); // 有已过期的
    expect(assignments.some((a) => !a.published)).toBe(true); // 有草稿
    expect(assignments.some((a) => a.manualOnly)).toBe(true);
    const subs = await h.owner.submission.groupBy({ by: ["status"], where: { tenantId: tenantId() }, _count: true });
    expect(subs.find((s) => s.status === "submitted")?._count).toBeGreaterThan(0); // 待批改队列
    expect(subs.find((s) => s.status === "published")?._count).toBeGreaterThan(0);
    const pending = await h.owner.studentRequest.findMany({ where: { tenantId: tenantId(), status: "pending" } });
    expect(pending.map((p) => p.kind).sort()).toEqual(["extension", "grade_appeal"]);
    expect(await h.owner.studentRequest.count({ where: { tenantId: tenantId(), status: { in: ["approved", "rejected"] } } })).toBe(2);
    // 复评窗口还开着：成绩是几天前发布的
    const published = await h.owner.finalGrade.findMany({ where: { tenantId: tenantId(), publishedAt: { gt: new Date(now - 14 * 864e5) } } });
    expect(published.length).toBeGreaterThanOrEqual(2);
    expect(await h.owner.announcement.count({ where: { tenantId: tenantId() } })).toBe(3);
    expect(await h.owner.discussionPost.count({ where: { tenantId: tenantId(), parentId: { not: null } } })).toBeGreaterThanOrEqual(2);
    expect(await h.owner.notification.count({ where: { tenantId: tenantId() } })).toBe(7);
    expect(await h.owner.transcriptIssue.count({ where: { tenantId: tenantId(), revokedAt: { not: null } } })).toBe(1);
    expect(await h.owner.gradeChange.count({ where: { tenantId: tenantId() } })).toBe(1);
    // 新旧两版培养方案，两个学生各按自己的入学年份
    expect(await h.owner.majorVersion.count({ where: { tenantId: tenantId(), effectiveYear: new Date().getUTCFullYear() } })).toBe(3);
    // 配额有上限，使用情况页有东西可看
    const t = await h.owner.tenant.findUniqueOrThrow({ where: { id: tenantId() } });
    expect(t.maxAccounts).toBeGreaterThan(0);
  });

  it("the demo superuser holds every admin menu and the 'all' data scope; the five accounts have the intended roles", async () => {
    const role = await h.owner.role.findFirstOrThrow({ where: { tenantId: tenantId(), code: DEMO_ROLE } });
    const have = new Set((await h.owner.roleMenu.findMany({ where: { roleId: role.id }, include: { menu: true } })).map((m) => m.menu.code));
    const granted = new Set((await h.owner.tenantMenuGrant.findMany({ where: { tenantId: tenantId() }, include: { menu: true } })).map((g) => g.menu.code));
    const wanted = MENU_CATALOG.filter((m) => entriesOf(m.code).includes("admin") && granted.has(m.code)).map((m) => m.code);
    expect(wanted.length).toBeGreaterThan(50);
    expect(wanted.filter((c) => !have.has(c))).toEqual([]);
    expect(await h.owner.roleDataScope.count({ where: { roleId: role.id, set: { kind: "all" } } })).toBe(1);
    const rolesOf = async (u: string) => (await h.owner.accountRole.findMany({ where: { account: { tenantId: tenantId(), username: u } }, include: { role: true } })).map((r) => r.role.code).sort();
    expect(await rolesOf("demo.admin")).toEqual([DEMO_ROLE, "tenant-admin"].sort());
    expect(await rolesOf("demo.registrar")).toEqual(["academic-manager"]);
    expect(await rolesOf("demo.teacher")).toEqual(["teacher"]);
    expect(await rolesOf("demo.student1")).toEqual(["student"]);
    expect(scenarioAccounts("demo").map((a) => a.username)).toEqual(["demo.admin", "demo.registrar", "demo.teacher", "demo.student1", "demo.student2"]);
    // 教师是本学期三个班的任课教师，所以能演示批改；管理员是 Python 班的助教
    const teacher = await h.owner.account.findFirstOrThrow({ where: { tenantId: tenantId(), username: "demo.teacher" } });
    expect(await h.owner.sectionInstructor.count({ where: { tenantId: tenantId(), personId: teacher.personId!, section: { term: { code: "DEMO-CUR" } } } })).toBe(3);
  });

  it("running it again adds nothing", async () => {
    const count = async () => [
      await h.owner.person.count({ where: { tenantId: tenantId() } }),
      await h.owner.account.count({ where: { tenantId: tenantId() } }),
      await h.owner.submission.count({ where: { tenantId: tenantId() } }),
      await h.owner.assignment.count({ where: { tenantId: tenantId() } }),
      await h.owner.studentRequest.count({ where: { tenantId: tenantId() } }),
      await h.owner.announcement.count({ where: { tenantId: tenantId() } }),
      await h.owner.notification.count({ where: { tenantId: tenantId() } }),
      await h.owner.discussionPost.count({ where: { tenantId: tenantId() } }),
    ];
    const before = await count();
    await run();
    expect(await count()).toEqual(before);
  });
});
