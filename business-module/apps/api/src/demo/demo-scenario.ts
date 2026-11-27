// 演示场景（B23）：一家"正在运转"的公司。所有日期相对运行当天，所以任何时候运行，都有"刚发布的成绩""快截止的作业"
// "待批改的提交""待处理的申请"。内容：上学期（已结课，成绩刚发布）、本学期（选课中，三个班，有已批改/待批改/未到期的作业）、
// 下学期（计划中）；演示账号（管理员、教师、教务、两名学生）和"演示超级角色"；公告、讨论、消息、申请、成绩单、培养方案新旧两版、配额用量。
// 只对带"演示"标记的公司运行（见 DEMO 保护）；可重复运行（按自然键先查后建）。用库所有者账号写库。
import { MENU_CATALOG, entriesOf, realmName } from "@staredu/shared";
import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "../generated/prisma";
import { addMissingTemplateMenus } from "../catalog/menu-sync";
import { endOfLocalDay } from "../edu/deadline";
import { DEFAULT_SCALE, gradeFor } from "../edu/grade-calc";
import { applyPenalty, DEFAULT_LATE_POLICY, hoursLate, penaltyPct } from "../edu/late-penalty";
import type { KeycloakAdmin } from "../keycloak/keycloak-admin";

export const DEMO_PASSWORD = "Demo!Passw0rd2026";
export const DEMO_ROLE = "demo-superuser";

export interface DemoAccountSpec { username: string; entry: "admin" | "portal"; label: string }
/** 一家演示公司的演示账号（登录页上列出的就是这几个）。prefix：hq 用 demo，加盟公司用 rv。 */
export function scenarioAccounts(prefix: string): DemoAccountSpec[] {
  return [
    { username: `${prefix}.admin`, entry: "admin", label: "Administrator with every permission" },
    { username: `${prefix}.registrar`, entry: "admin", label: "Academic office" },
    { username: `${prefix}.teacher`, entry: "admin", label: "Teacher" },
    { username: `${prefix}.student1`, entry: "portal", label: "Student" },
    { username: `${prefix}.student2`, entry: "portal", label: "Student" },
  ];
}

export interface ScenarioOptions {
  owner: PrismaClient;
  tenantCode: string;
  prefix: string;
  now?: Date;
  keycloak?: KeycloakAdmin;
  password?: string;
  log?: (line: string) => void;
}
export interface ScenarioResult { terms: number; sections: number; assignments: number; submissions: number; requests: number; announcements: number; accounts: number }

const DAY = 86_400_000;
const find = async <T>(f: () => Promise<T | null>, c: () => Promise<T>): Promise<T> => (await f()) ?? (await c());

export async function seedScenario(opts: ScenarioOptions): Promise<ScenarioResult> {
  const { owner, prefix } = opts;
  const log = opts.log ?? (() => undefined);
  const now = opts.now ?? new Date();
  const tenant = await owner.tenant.findUnique({ where: { code: opts.tenantCode } });
  if (!tenant) throw new Error(`tenant "${opts.tenantCode}" not found (run pnpm seed first)`);
  if (!tenant.isDemo) throw new Error(`tenant "${tenant.code}" is not marked as a demo company; refusing to create demo accounts or data`);
  const tenantId = tenant.id;
  const campus = await owner.campus.findFirstOrThrow({ where: { tenantId, type: "hq" } });
  const tz = campus.timezone;
  const dateOf = (offsetDays: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + offsetDays * DAY);
  const dayStr = (offsetDays: number) => dateOf(offsetDays).toISOString().slice(0, 10);
  const at = (offsetDays: number, hour = 10) => new Date(dateOf(offsetDays).getTime() + hour * 3600_000);

  // ------------------------------------------------------------ 角色
  await addMissingTemplateMenus(owner, tenantId); // 把模板后来新增的菜单补进公司已复制的角色（老公司的副本可能是旧的）
  const roleId = async (code: string) => (await owner.role.findFirstOrThrow({ where: { tenantId, code, deletedAt: null } })).id;
  const adminMenus = new Set(MENU_CATALOG.filter((m) => entriesOf(m.code).includes("admin")).map((m) => m.code));
  const granted = await owner.tenantMenuGrant.findMany({ where: { tenantId }, select: { menuId: true } });
  const menus = await owner.menu.findMany({ where: { tenantId: null, deletedAt: null, id: { in: granted.map((g) => g.menuId) } }, select: { id: true, code: true } });
  const superRole = await find(
    () => owner.role.findFirst({ where: { tenantId, code: DEMO_ROLE } }),
    () => owner.role.create({ data: { tenantId, code: DEMO_ROLE, name: "Demo superuser (demonstration only)", kind: "custom", sort: 999 } }),
  );
  const wantMenus = menus.filter((m) => m.code && adminMenus.has(m.code)).map((m) => m.id);
  await owner.roleMenu.deleteMany({ where: { roleId: superRole.id } });
  await owner.roleMenu.createMany({ data: wantMenus.map((menuId) => ({ tenantId, roleId: superRole.id, menuId })), skipDuplicates: true });
  const allScope = await owner.dataScopeSet.findFirstOrThrow({ where: { tenantId: null, kind: "all" } });
  await owner.roleDataScope.createMany({ data: [{ tenantId, roleId: superRole.id, setId: allScope.id }], skipDuplicates: true });

  // ------------------------------------------------------------ 人员和账号
  const ensureStaff = async (no: string, name: string) => {
    const existing = await owner.staffProfile.findFirst({ where: { tenantId, employeeNo: no } });
    if (existing) return existing.personId;
    const p = await owner.person.create({ data: { tenantId, type: "staff", fullName: name } });
    await owner.staffProfile.create({ data: { tenantId, personId: p.id, employeeNo: no, hireDate: new Date("2022-09-01") } });
    await owner.personDept.create({ data: { tenantId, personId: p.id, deptId: campus.deptId, isPrimary: true } });
    return p.id;
  };
  const ensureStudent = async (no: string, name: string) => {
    const existing = await owner.studentProfile.findFirst({ where: { tenantId, studentNo: no } });
    if (existing) return existing.personId;
    const p = await owner.person.create({ data: { tenantId, type: "student", fullName: name } });
    await owner.studentProfile.create({ data: { tenantId, personId: p.id, studentNo: no, campusId: campus.id, academicStatus: "enrolled", enrollTerm: "demo" } });
    await owner.personDept.create({ data: { tenantId, personId: p.id, deptId: campus.deptId, kind: "student", isPrimary: true } });
    return p.id;
  };
  const P = prefix.toUpperCase();
  const adminPerson = await ensureStaff(`${P}-ADMIN`, "Alex Demo (admin)");
  const teacherPerson = await ensureStaff(`${P}-TEACHER`, "Taylor Demo (teacher)");
  const registrarPerson = await ensureStaff(`${P}-REGISTRAR`, "Riley Demo (registrar)");
  const s1 = await ensureStudent(`${P}-S1`, "Sam Demo (student 1)");
  const s2 = await ensureStudent(`${P}-S2`, "Jo Demo (student 2)");

  const password = opts.password ?? process.env.DEMO_PASSWORD ?? DEMO_PASSWORD;
  const realm = realmName("tenant", tenant.code);
  const accountIds = new Map<string, string>();
  const ensureAccount = async (username: string, personId: string, roles: string[]) => {
    let account = await owner.account.findFirst({ where: { tenantId, username } });
    account ??= await owner.account.create({ data: { tenantId, username, email: `${username}@${tenant.code}.example.test`, personId, status: "active" } });
    if (opts.keycloak && !account.keycloakUserId) {
      const existing = await opts.keycloak.findUser(realm, username);
      const userId = existing?.id ?? (await opts.keycloak.createUser(realm, { username, email: account.email ?? undefined, accountId: account.id, password }));
      if (existing) await opts.keycloak.resetPassword(realm, existing.id, password, false);
      account = await owner.account.update({ where: { id: account.id }, data: { keycloakUserId: userId } });
    }
    for (const code of roles) {
      const rid = await roleId(code);
      await owner.accountRole.upsert({ where: { accountId_roleId: { accountId: account.id, roleId: rid } }, create: { tenantId, accountId: account.id, roleId: rid }, update: {} });
    }
    accountIds.set(username, account.id);
    return account.id;
  };
  await ensureAccount(`${prefix}.admin`, adminPerson, ["tenant-admin", DEMO_ROLE]);
  await ensureAccount(`${prefix}.registrar`, registrarPerson, ["academic-manager"]);
  await ensureAccount(`${prefix}.teacher`, teacherPerson, ["teacher"]);
  await ensureAccount(`${prefix}.student1`, s1, ["student"]);
  await ensureAccount(`${prefix}.student2`, s2, ["student"]);

  // ------------------------------------------------------------ 课程、专业、培养方案（旧版 + 新版）
  const year = now.getUTCFullYear();
  const courseDefs = [
    { code: "JAVA101", name: "Java Programming" },
    { code: "PYTHON101", name: "Python Programming" },
    { code: "TS101", name: "TypeScript Programming" },
  ];
  const courses: Record<string, string> = {};
  for (const d of courseDefs) {
    const course = await find(
      () => owner.course.findFirst({ where: { tenantId, code: d.code, deletedAt: null } }),
      () => owner.course.create({ data: { tenantId, code: d.code, name: d.name, credits: 3 } }),
    );
    courses[d.code] = course.id;
    const major = await find(
      () => owner.major.findFirst({ where: { tenantId, code: d.code, deletedAt: null } }),
      () => owner.major.create({ data: { tenantId, code: d.code, name: d.name, degreeType: "certificate", totalCredits: 3 } }),
    );
    const base = await find(
      () => owner.majorVersion.findFirst({ where: { majorId: major.id }, orderBy: { effectiveYear: "asc" } }),
      () => owner.majorVersion.create({ data: { tenantId, majorId: major.id, label: "Initial", effectiveYear: 2000, totalCredits: 3 } }),
    );
    await find(
      () => owner.majorCourse.findFirst({ where: { versionId: base.id, courseId: course.id } }),
      () => owner.majorCourse.create({ data: { tenantId, majorId: major.id, versionId: base.id, courseId: course.id, category: "required", suggestedTerm: 1 } }),
    );
    // 新版：本年入学的同学用，要求学分更高、多一门选修（用另外一门课）
    const next = await find(
      () => owner.majorVersion.findFirst({ where: { majorId: major.id, effectiveYear: year } }),
      () => owner.majorVersion.create({ data: { tenantId, majorId: major.id, label: `${year} curriculum`, effectiveYear: year, totalCredits: 6, electiveMinCredits: 3 } }),
    );
    const other = courseDefs.find((x) => x.code !== d.code) as { code: string; name: string };
    const otherCourse = courses[other.code] ?? (await find(
      () => owner.course.findFirst({ where: { tenantId, code: other.code, deletedAt: null } }),
      () => owner.course.create({ data: { tenantId, code: other.code, name: other.name, credits: 3 } }),
    )).id;
    courses[other.code] = otherCourse;
    await find(
      () => owner.majorCourse.findFirst({ where: { versionId: next.id, courseId: course.id } }),
      () => owner.majorCourse.create({ data: { tenantId, majorId: major.id, versionId: next.id, courseId: course.id, category: "required", suggestedTerm: 1 } }),
    );
    await find(
      () => owner.majorCourse.findFirst({ where: { versionId: next.id, courseId: otherCourse } }),
      () => owner.majorCourse.create({ data: { tenantId, majorId: major.id, versionId: next.id, courseId: otherCourse, category: "elective", suggestedTerm: 2 } }),
    );
  }
  // 课程和专业各凑到 20 个左右：列表、搜索、选择窗口、分页这些界面才看得出问题。每个专业有旧版（初版）和新版（本年）培养方案，几门课有先修课。
  const extraCourses: Array<[string, string, number]> = [
    ["CS101", "Introduction to Computer Science", 3], ["DS201", "Data Structures", 4], ["ALG301", "Algorithms", 4], ["DB201", "Database Systems", 3],
    ["OS301", "Operating Systems", 4], ["NET201", "Computer Networks", 3], ["SWE301", "Software Engineering", 3], ["AI201", "Introduction to Artificial Intelligence", 3],
    ["ML301", "Machine Learning", 4], ["MATH101", "Calculus I", 4], ["MATH102", "Linear Algebra", 3], ["STAT201", "Probability and Statistics", 3],
    ["WEB201", "Web Development", 3], ["MOB301", "Mobile App Development", 3], ["SEC301", "Information Security", 3], ["CLOUD301", "Cloud Computing", 3], ["UX101", "UX Design Basics", 2],
  ];
  for (const [code, name, credits] of extraCourses) {
    courses[code] = (await find(
      () => owner.course.findFirst({ where: { tenantId, code, deletedAt: null } }),
      () => owner.course.create({ data: { tenantId, code, name, credits } }),
    )).id;
  }
  const prereqs: Array<[string, string]> = [["DS201", "CS101"], ["ALG301", "DS201"], ["DB201", "CS101"], ["OS301", "DS201"], ["ML301", "AI201"], ["AI201", "MATH102"], ["STAT201", "MATH101"], ["CLOUD301", "NET201"]];
  for (const [code, pre] of prereqs) {
    await find(
      () => owner.coursePrerequisite.findFirst({ where: { courseId: courses[code], prerequisiteId: courses[pre] } }),
      () => owner.coursePrerequisite.create({ data: { tenantId, courseId: courses[code], prerequisiteId: courses[pre] } }),
    );
  }
  const allCodes = Object.keys(courses);
  const extraMajors: Array<[string, string, string, number]> = [
    ["CS", "Computer Science", "bachelor", 120], ["SE", "Software Engineering", "bachelor", 120], ["DSCI", "Data Science", "bachelor", 120], ["AIE", "Artificial Intelligence", "bachelor", 120],
    ["CYB", "Cybersecurity", "bachelor", 120], ["IS", "Information Systems", "bachelor", 110], ["NETE", "Network Engineering", "bachelor", 110], ["WEBD", "Web Development", "associate", 70],
    ["MOBD", "Mobile App Development", "associate", 70], ["CLOUD", "Cloud Computing", "associate", 70], ["AMATH", "Applied Mathematics", "bachelor", 120], ["STATS", "Statistics", "bachelor", 120],
    ["UXD", "UX Design", "associate", 66], ["GAME", "Game Development", "bachelor", 120], ["EMBED", "Embedded Systems", "bachelor", 120], ["DEVOPS", "DevOps Engineering", "associate", 72], ["BANA", "Business Analytics", "master", 36],
  ];
  for (const [i, [code, name, degreeType, totalCredits]] of extraMajors.entries()) {
    const major = await find(
      () => owner.major.findFirst({ where: { tenantId, code, deletedAt: null } }),
      () => owner.major.create({ data: { tenantId, code, name, degreeType, totalCredits } }),
    );
    const required = [0, 1, 2, 3].map((k) => allCodes[(i * 3 + k) % allCodes.length]);
    const elective = allCodes[(i * 3 + 7) % allCodes.length];
    const mkVersion = async (label: string, effectiveYear: number, withElective: boolean) => {
      const v = await find(
        () => owner.majorVersion.findFirst({ where: { majorId: major.id, effectiveYear } }),
        () => owner.majorVersion.create({ data: { tenantId, majorId: major.id, label, effectiveYear, totalCredits, electiveMinCredits: withElective ? 6 : 0 } }),
      );
      for (const [k, courseCode] of [...required, ...(withElective && !required.includes(elective) ? [elective] : [])].entries()) {
        await find(
          () => owner.majorCourse.findFirst({ where: { versionId: v.id, courseId: courses[courseCode] } }),
          () => owner.majorCourse.create({ data: { tenantId, majorId: major.id, versionId: v.id, courseId: courses[courseCode], category: courseCode === elective && k >= required.length ? "elective" : "required", suggestedTerm: (k % 4) + 1 } }),
        );
      }
    };
    await mkVersion("Initial", 2000, false);
    await mkVersion(`${year} curriculum`, year, true);
  }
  const majorJava = await owner.major.findFirstOrThrow({ where: { tenantId, code: "JAVA101" } });
  for (const [personId, entryYear] of [[s1, year - 1], [s2, year]] as const) {
    await find(
      () => owner.studentMajor.findFirst({ where: { personId, majorId: majorJava.id } }),
      () => owner.studentMajor.create({ data: { tenantId, personId, majorId: majorJava.id, kind: "primary", entryYear, declaredOn: dateOf(-60) } }),
    );
  }

  // ------------------------------------------------------------ 学期
  const mkTerm = (code: string, name: string, start: number, end: number, openA: number | null, closeA: number | null, drop: number | null, status: "planned" | "enrolling" | "in_progress" | "ended") =>
    find(
      () => owner.term.findFirst({ where: { tenantId, code, deletedAt: null } }),
      () => owner.term.create({ data: { tenantId, code, name, startDate: dateOf(start), endDate: dateOf(end), enrollOpenDate: openA === null ? null : dateOf(openA), enrollCloseDate: closeA === null ? null : dateOf(closeA), dropDeadline: drop === null ? null : dateOf(drop), status } }),
    );
  const prevTerm = await mkTerm(`${P}-PREV`, "Previous term", -150, -20, -180, -140, -120, "ended");
  const curTerm = await mkTerm(`${P}-CUR`, "Current term", -14, 90, -30, 20, 35, "enrolling");
  const nextTerm = await mkTerm(`${P}-NEXT`, "Next term", 120, 240, 90, 130, 150, "planned");

  const mkSection = async (termId: string, courseCode: string, number: string, capacity: number, status: "draft" | "open" | "ended", instructors: string[], schedule: unknown[] = []) => {
    const course = await owner.course.findFirstOrThrow({ where: { id: courses[courseCode] } });
    const section = await find(
      () => owner.section.findFirst({ where: { courseId: course.id, termId, number } }),
      () => owner.section.create({ data: { tenantId, courseId: course.id, termId, campusId: campus.id, number, name: `${course.name} (${P} ${number})`, capacity, status, schedule: schedule as never } }),
    );
    for (const [i, personId] of instructors.entries()) {
      await find(
        () => owner.sectionInstructor.findFirst({ where: { sectionId: section.id, personId } }),
        () => owner.sectionInstructor.create({ data: { tenantId, sectionId: section.id, personId, role: i === 0 ? "lead" : "assistant" } }),
      );
    }
    return section;
  };
  const sched = (days: number[], start: string, end: string, room: string) => days.map((weekday) => ({ weekday, start, end, room }));
  const prevSec = await mkSection(prevTerm.id, "TS101", "P1", 20, "ended", [teacherPerson], sched([2, 4], "09:00", "10:30", "A101"));
  const javaSec = await mkSection(curTerm.id, "JAVA101", "01", 12, "open", [teacherPerson], sched([1, 3], "09:00", "10:30", "B201"));
  const pySec = await mkSection(curTerm.id, "PYTHON101", "01", 30, "open", [teacherPerson, adminPerson], sched([2, 4], "13:00", "14:30", "B202"));
  const tsSec = await mkSection(curTerm.id, "TS101", "01", 30, "open", [teacherPerson], sched([5], "10:00", "12:00", "C301"));
  await mkSection(nextTerm.id, "JAVA101", "N1", 30, "draft", [teacherPerson]);

  // 同学：hq 用样本里的在读学员，加盟公司用已有的（没有就少一点）
  const fillerProfiles = await owner.studentProfile.findMany({ where: { tenantId, academicStatus: "enrolled", NOT: { studentNo: { startsWith: `${P}-` } } }, orderBy: { studentNo: "asc" }, take: 40 });
  let fillers = fillerProfiles.map((f) => f.personId);
  if (fillers.length < 8) {
    for (let i = 1; i <= 8 - fillers.length; i++) fillers.push(await ensureStudent(`${P}-F${i}`, `Classmate ${i}`));
    fillers = [...fillers];
  }
  const enroll = async (sectionId: string, personId: string, status: "enrolled" | "completed" = "enrolled", enrolledOffset = -20) => {
    const existing = await owner.enrollment.findFirst({ where: { sectionId, studentPersonId: personId } });
    return existing ?? owner.enrollment.create({ data: { tenantId, sectionId, studentPersonId: personId, method: "registrar", reason: "demo data", enrolledAt: at(enrolledOffset), status } });
  };
  // 本学期：java 11/12 个座位（接近满员）、python、ts
  const javaRoster = [s1, s2, ...fillers.slice(0, 9)];
  const pyRoster = [s1, ...fillers.slice(9, 17)];
  const tsRoster = fillers.slice(17, 23);
  for (const p of javaRoster) await enroll(javaSec.id, p);
  for (const p of pyRoster) await enroll(pySec.id, p);
  for (const p of tsRoster) await enroll(tsSec.id, p);

  // ------------------------------------------------------------ 上学期：已结课，成绩刚发布（学生还能在窗口内申请复评）
  const prevEnrollments = new Map<string, string>();
  for (const [personId, total] of [[s1, 88.5], [s2, 71.0]] as const) {
    const e = await enroll(prevSec.id, personId, "completed", -140);
    prevEnrollments.set(personId, e.id);
    const g = gradeFor(DEFAULT_SCALE, total);
    if (!(await owner.finalGrade.findFirst({ where: { enrollmentId: e.id } }))) {
      await owner.finalGrade.create({ data: { tenantId, enrollmentId: e.id, total, grade: g.grade, gradePoints: g.points, passed: g.passing, breakdown: [{ name: "Assignments", weight: 100 }] as never, computedAt: at(-6), publishedAt: at(-4) } });
      await owner.enrollment.update({ where: { id: e.id }, data: { passed: g.passing } });
    }
  }
  // 一次成绩更正的记录（演示"改前改后留痕"）
  const s1Enr = prevEnrollments.get(s1) as string;
  if (!(await owner.gradeChange.findFirst({ where: { enrollmentId: s1Enr } }))) {
    await owner.gradeChange.create({ data: { tenantId, enrollmentId: s1Enr, kind: "amend", before: { total: 86.0, grade: "B", passed: true }, after: { total: 88.5, grade: "B", passed: true }, reason: "Marking error in the final project found on review", changedAt: at(-3) } });
  }
  // 成绩单：一份正式、一份已作废（验真页两种状态都能看）
  const snap = { institution: tenant.name, studentName: "Sam Demo (student 1)", studentNo: `${P}-S1`, major: "Java Programming", campus: campus.name, cumulativeGpa: 3.0, creditsEarned: 3, creditsAttempted: 3, terms: 1 };
  const issue = async (seq: number, revoked: boolean) => {
    const docNumber = `TR-${year}-${P}${String(seq).padStart(3, "0")}`;
    if (await owner.transcriptIssue.findFirst({ where: { tenantId, docNumber } })) return;
    await owner.transcriptIssue.create({
      data: {
        tenantId, studentPersonId: s1, docNumber, version: "formal", verifyToken: randomBytes(18).toString("base64url"), contentHash: createHash("sha256").update(`${docNumber}${tenantId}`).digest("hex").toUpperCase(),
        snapshot: snap, generatedAt: at(-2), ...(revoked ? { revokedAt: at(-1), revokeReason: "Reissued after a name correction" } : {}),
      },
    });
  };
  await issue(1, true);
  await issue(2, false);

  // ------------------------------------------------------------ 本学期的作业和提交
  const endOfDay = (offset: number) => endOfLocalDay(dayStr(offset), tz);
  const mkGroups = async (sectionId: string) => {
    const hw = await find(() => owner.assignmentGroup.findFirst({ where: { sectionId, name: "Homework" } }), () => owner.assignmentGroup.create({ data: { tenantId, sectionId, name: "Homework", weight: 60 } }));
    const exam = await find(() => owner.assignmentGroup.findFirst({ where: { sectionId, name: "Exam" } }), () => owner.assignmentGroup.create({ data: { tenantId, sectionId, name: "Exam", weight: 40, sort: 1 } }));
    return { hw: hw.id, exam: exam.id };
  };
  const mkAssignment = async (sectionId: string, groupId: string, title: string, dueOffset: number, o: { published?: boolean; manualOnly?: boolean } = {}) => {
    const existing = await owner.assignment.findFirst({ where: { sectionId, title } });
    if (existing) return existing;
    const a = await owner.assignment.create({
      data: {
        tenantId, sectionId, groupId, title, description: `${title}: demo assignment`, dueDate: dateOf(dueOffset), dueAt: endOfDay(dueOffset), latePolicy: DEFAULT_LATE_POLICY as never,
        maxScore: 100, manualOnly: o.manualOnly ?? false, published: o.published ?? true, publishedAt: o.published === false ? null : at(dueOffset - 14),
      },
    });
    const items = o.manualOnly ? [["Exam", 100]] : [["Correctness", 70], ["Style", 30]];
    for (const [i, [t, pts]] of items.entries()) await owner.rubricItem.create({ data: { tenantId, assignmentId: a.id, title: String(t), maxPoints: Number(pts), sort: i } });
    return a;
  };
  const submit = async (a: { id: string; dueAt: Date }, personId: string, submittedAt: Date, state: "submitted" | "published", raw = 0) => {
    if (await owner.submission.findFirst({ where: { assignmentId: a.id, studentPersonId: personId } })) return false;
    const hrs = hoursLate(a.dueAt, submittedAt);
    const pct = hrs > 0 ? penaltyPct(DEFAULT_LATE_POLICY, hrs) : 0;
    const sub = await owner.submission.create({
      data: {
        tenantId, assignmentId: a.id, studentPersonId: personId, status: state, submittedAt, isLate: hrs > 0, hoursLate: hrs,
        ...(state === "published" ? { rawScore: raw, latePenaltyPct: pct, finalScore: applyPenalty(raw, pct), gradedAt: submittedAt, publishedAt: submittedAt, feedback: "Good work overall. See the comments per item." } : {}),
      },
    });
    await owner.submissionVersion.create({ data: { tenantId, submissionId: sub.id, version: 1, submittedAt, isLate: hrs > 0, textAnswer: "(demo submission)" } });
    if (state === "published") {
      const items = await owner.rubricItem.findMany({ where: { assignmentId: a.id }, orderBy: { sort: "asc" } });
      for (const [i, item] of items.entries()) await owner.submissionScore.create({ data: { tenantId, submissionId: sub.id, rubricItemId: item.id, points: items.length === 1 ? raw : i === 0 ? Math.round(raw * 0.7 * 10) / 10 : Math.round(raw * 0.3 * 10) / 10, comment: i === 0 ? "Check edge cases." : null } });
    }
    return true;
  };
  let assignments = 0, submissions = 0;
  const sections = [{ s: javaSec, roster: javaRoster }, { s: pySec, roster: pyRoster }, { s: tsSec, roster: tsRoster }];
  const hw3Java: { id: string; dueAt: Date }[] = [];
  for (const { s, roster } of sections) {
    const g = await mkGroups(s.id);
    await owner.assignmentGroup.update({ where: { id: g.hw }, data: { weight: 60 } });
    const hw1 = await mkAssignment(s.id, g.hw, "Homework 1", -12);
    const hw2 = await mkAssignment(s.id, g.hw, "Homework 2", -3);
    const hw3 = await mkAssignment(s.id, g.hw, "Homework 3", 5);
    await mkAssignment(s.id, g.exam, "Midterm exam", 30, { manualOnly: true });
    await mkAssignment(s.id, g.hw, "Final project (draft)", 40, { published: false });
    assignments += 5;
    if (s.id === javaSec.id) hw3Java.push(hw3);
    for (const [i, personId] of roster.entries()) {
      const raw = 55 + ((i * 11) % 45);
      if (await submit(hw1, personId, new Date(hw1.dueAt.getTime() - (6 + i) * 3600_000), "published", raw)) submissions++;
      // 作业 2：大多数已交、还没批（待批改队列）；每隔三个人迟交
      if (i % 5 !== 4 && (await submit(hw2, personId, new Date(hw2.dueAt.getTime() + (i % 3 === 2 ? 5 * 3600_000 : -(2 + i) * 3600_000)), "submitted"))) submissions++;
    }
  }
  // 作业 3（java）：学生 2 已交；学生 1 还没交，并且申请了延期（待处理）
  const hw3 = hw3Java[0];
  if (await submit(hw3, s2, at(0, 8), "submitted")) submissions++;

  // ------------------------------------------------------------ 申请：待处理的复评和延期，和两条已处理的
  const mkRequest = async (data: { kind: string; sectionId: string; studentPersonId: string; enrollmentId?: string; assignmentId?: string; days?: number; reason: string; status: string; decisionNote?: string; decidedBy?: string; result?: unknown }) => {
    const exists = await owner.studentRequest.findFirst({ where: { tenantId, kind: data.kind, studentPersonId: data.studentPersonId, enrollmentId: data.enrollmentId ?? null, assignmentId: data.assignmentId ?? null, reason: data.reason } });
    if (exists) return false;
    await owner.studentRequest.create({
      data: { tenantId, kind: data.kind, sectionId: data.sectionId, studentPersonId: data.studentPersonId, enrollmentId: data.enrollmentId, assignmentId: data.assignmentId, days: data.days, reason: data.reason, status: data.status, decisionNote: data.decisionNote, decidedBy: data.decidedBy, decidedAt: data.status === "pending" ? null : at(-1), result: data.result as never },
    });
    return true;
  };
  const teacherAccount = accountIds.get(`${prefix}.teacher`) as string;
  let requests = 0;
  if (await mkRequest({ kind: "extension", sectionId: javaSec.id, studentPersonId: s1, assignmentId: hw3.id, days: 2, reason: "I have a hospital appointment on the due date.", status: "pending" })) requests++;
  if (await mkRequest({ kind: "grade_appeal", sectionId: prevSec.id, studentPersonId: s2, enrollmentId: prevEnrollments.get(s2), reason: "I believe question 4 of the final exam was marked too strictly.", status: "pending" })) requests++;
  const hw1Py = await owner.assignment.findFirstOrThrow({ where: { sectionId: pySec.id, title: "Homework 1" } });
  if (await mkRequest({ kind: "extension", sectionId: pySec.id, studentPersonId: s1, assignmentId: hw1Py.id, days: 3, reason: "Laptop was being repaired last week.", status: "rejected", decisionNote: "The deadline was already past when you asked.", decidedBy: teacherAccount })) requests++;
  const hw2Py = await owner.assignment.findFirstOrThrow({ where: { sectionId: pySec.id, title: "Homework 2" } });
  if (await mkRequest({ kind: "extension", sectionId: pySec.id, studentPersonId: s1, assignmentId: hw2Py.id, days: 2, reason: "Family event over the weekend.", status: "approved", decisionNote: "Approved, two extra days.", decidedBy: teacherAccount, result: { days: 2 } })) {
    requests++;
    await owner.assignmentExtension.create({ data: { tenantId, assignmentId: hw2Py.id, studentPersonId: s1, days: 2, reason: "Student request: Approved, two extra days.", grantedBy: teacherAccount } });
  }

  // ------------------------------------------------------------ 公告、讨论
  const admin = accountIds.get(`${prefix}.admin`) as string;
  let announcements = 0;
  for (const a of [
    { title: "Welcome to the new term", body: "Classes started two weeks ago. Course enrollment closes in 20 days.", scopeKind: "tenant" },
    { title: "Campus network maintenance", body: "The campus network will be unavailable on Saturday from 22:00 to 24:00.", scopeKind: "campus", campusId: campus.id },
    { title: "Java: lab session moved", body: "This week's lab session moves to room B205.", scopeKind: "section", sectionId: javaSec.id },
  ]) {
    if (await owner.announcement.findFirst({ where: { tenantId, title: a.title } })) continue;
    await owner.announcement.create({ data: { tenantId, ...a, recipients: a.scopeKind === "tenant" ? 40 : 12, createdBy: admin, createdAt: at(-5) } });
    announcements++;
  }
  const post = async (sectionId: string, authorPersonId: string, title: string | null, body: string, o: { parentId?: string; pinned?: boolean; resolved?: boolean; offset?: number } = {}) => {
    const exists = await owner.discussionPost.findFirst({ where: { sectionId, body } });
    return exists ?? owner.discussionPost.create({ data: { tenantId, sectionId, authorPersonId, title, body, parentId: o.parentId, pinned: o.pinned ?? false, resolved: o.resolved ?? false, createdAt: at(o.offset ?? -2) } });
  };
  await post(javaSec.id, teacherPerson, "Read this first: course rules", "Assignments are due at 23:59 campus time. Late work loses 10% per day.", { pinned: true, offset: -13 });
  const q = await post(javaSec.id, s1, "Question about Homework 2", "Can we use records instead of classes for the data holders?", { resolved: true, offset: -4 });
  await post(javaSec.id, teacherPerson, null, "Yes, records are fine as long as the fields stay immutable.", { parentId: q.id, offset: -4 });
  await post(javaSec.id, s2, null, "Thanks, that answers my question too.", { parentId: q.id, offset: -3 });
  await post(pySec.id, s1, "Which Python version do we use?", "Is Python 3.11 fine for the labs?", { offset: -1 });

  // ------------------------------------------------------------ 消息（站内通知）
  const notify = async (username: string, type: string, params: Record<string, string>, key: string, offset: number, read = false) => {
    const accountId = accountIds.get(username) as string;
    if (await owner.notification.findFirst({ where: { accountId, dedupeKey: key } })) return;
    const category = type.startsWith("request.") ? "request" : type.startsWith("final_grade") ? "grade" : type.startsWith("submission") ? "grade" : "assignment";
    await owner.notification.create({ data: { tenantId, accountId, category, type, params: params as never, dedupeKey: key, createdAt: at(offset), readAt: read ? at(offset + 1) : null } });
  };
  const sName = javaSec.name;
  await notify(`${prefix}.student1`, "assignment.published", { title: "Homework 3", section: sName, dueDate: dayStr(5) }, "demo-n1", -9);
  await notify(`${prefix}.student1`, "submission.published", { title: "Homework 1", section: sName }, "demo-n2", -8, true);
  await notify(`${prefix}.student1`, "final_grade.published", { section: prevSec.name }, "demo-n3", -4);
  await notify(`${prefix}.student1`, "request.extension_approved", { section: pySec.name, title: "Homework 2", days: "2", note: "Approved, two extra days." }, "demo-n4", -1);
  await notify(`${prefix}.student2`, "final_grade.published", { section: prevSec.name }, "demo-n5", -4);
  await notify(`${prefix}.teacher`, "request.extension_submitted", { section: sName, student: "Sam Demo (student 1)", title: "Homework 3", days: "2" }, "demo-n6", 0);
  await notify(`${prefix}.registrar`, "request.appeal_submitted", { section: prevSec.name, student: "Jo Demo (student 2)" }, "demo-n7", 0);

  // ------------------------------------------------------------ 配额用量（平台控制台的"使用情况与配额"有东西可看）
  const accountCount = await owner.account.count({ where: { tenantId, deletedAt: null } });
  await owner.tenant.update({ where: { id: tenantId }, data: { maxAccounts: accountCount + 12, maxStorageMb: 500 } });

  log(`scenario ${tenant.code}: 3 terms, ${assignments} current assignments, ${submissions} new submissions, ${requests} requests, ${announcements} announcements`);
  return { terms: 3, sections: 5, assignments, submissions, requests, announcements, accounts: accountIds.size };
}
