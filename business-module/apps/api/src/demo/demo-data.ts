// 演示数据（B13）：让业务模块和 AI 模块描述同一家公司。
// 前提：租户已开通，校区/员工/学员已用 `pnpm import:sample` 导入（样本里的 BJ 对应业务模块的总部校区 HQ）。
// 这里补上其余部分，全部来自 ai-module/sample-data：
//   1. 教学：三个方向（java / python / typescript）各一门课、一个专业；每个"方向 × 校区"一个班（2026 春季学期，已结束）；
//      样本的 12 次作业、198 份提交（原始分、迟交、扣分、最终分原样写入）；总评按成绩模块的同一套算法算出并发布；
//   2. 演示账号：样本的 9 个账号，业务库里一个账号 + Keycloak 一个用户（同一个演示密码），关联到对应的人员；
//   3. 文档库：样本的现行文档，按 access 级别放进文件夹（公开 / 内部 / 机密），带授权；Kafka 模式下发 library.file_changed 让 AI 入库。
// 可重复运行：每一项都按自然键先查后建，第二次运行不新增任何记录。
// 用库所有者账号写库（和"开通租户"一样，是运维操作，不是租户的请求）。
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { PrismaClient } from "../generated/prisma";
import { Prisma } from "../generated/prisma";
import { realmName } from "@staredu/shared";
import { parseCsvRecords } from "../hr/csv";
import { endOfLocalDay } from "../edu/deadline";
import { DEFAULT_LATE_POLICY } from "../edu/late-penalty";
import { DEFAULT_SCALE, finalTotal, gradeFor } from "../edu/grade-calc";
import type { KeycloakAdmin } from "../keycloak/keycloak-admin";

export const DEMO_PASSWORD_DEFAULT = "Demo!Passw0rd2026";
/** 样本里的校区编号 → 业务模块的校区代码（样本的总部校区 BJ 在业务模块里是 HQ）。 */
export const CAMPUS_ALIASES: Record<string, string> = { BJ: "HQ" };
const TERM_CODE = "2026S1";

const PROGRAMS = {
  java: { course: "JAVA101", name: "Java Programming" },
  python: { course: "PYTHON101", name: "Python Programming" },
  typescript: { course: "TS101", name: "TypeScript Programming" },
} as const;

/** 演示账号：样本角色 → 业务模块角色（没有对应角色的不分配，只能登录看自己的）。 */
export function demoRoles(role: string, title: string): string[] {
  if (role === "student") return ["student"];
  if (role === "manager") return ["campus-lead"];
  if (role === "hr") return ["hr-manager"];
  if (role === "Admin") return ["tenant-admin"];
  if (role === "staff" && /instructor/i.test(title)) return ["teacher"];
  return []; // 招生顾问、财务、知识库管理员：业务模块还没有对应的功能角色
}

/** 文档 access 级别 → 文件夹类型和授权。staff 与 all-staff 在业务模块里是同一档（全体员工）。 */
const ACCESS: Record<string, { label: string; classification: "public" | "internal" | "confidential"; grant: { type: string; roles?: string[] } }> = {
  "students-and-staff": { label: "students and staff", classification: "public", grant: { type: "everyone" } },
  "all-staff": { label: "all staff", classification: "internal", grant: { type: "all_staff" } },
  staff: { label: "all staff", classification: "internal", grant: { type: "all_staff" } },
  managers: { label: "managers", classification: "internal", grant: { type: "role", roles: ["campus-lead", "hr-manager"] } },
  "finance-and-hr": { label: "finance and HR (confidential)", classification: "confidential", grant: { type: "role", roles: ["hr-manager"] } },
  "hr-only": { label: "HR only (confidential)", classification: "confidential", grant: { type: "role", roles: ["hr-manager"] } },
};
const DOMAIN_TITLES: Record<string, string> = { finance: "Finance", hr: "HR", "tech-support": "IT support" };
const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  md: "text/markdown",
  txt: "text/plain",
};

export interface DemoOptions {
  owner: PrismaClient;
  tenantCode: string;
  /** ai-module/sample-data */
  sampleDir: string;
  /** 给了就建演示账号对应的 Keycloak 用户；没给只建业务库账号 */
  keycloak?: KeycloakAdmin;
  password?: string;
  /** 写对象存储（文档库文件）；没给就跳过文档库 */
  putObject?: (key: string, body: Buffer, contentType: string) => Promise<void>;
  /** 是否发 library.file_changed（Kafka 事件总线模式才发） */
  emitLibraryEvents?: boolean;
  log?: (line: string) => void;
}

export interface DemoResult {
  courses: number;
  sections: number;
  assignments: number;
  submissions: number;
  enrollments: number;
  finalGrades: number;
  accounts: number;
  folders: number;
  files: number;
}

const read = (dir: string, rel: string) => readFileSync(resolve(dir, rel), "utf8");
const records = (dir: string, rel: string) => parseCsvRecords(read(dir, rel));

export async function seedDemo(opts: DemoOptions): Promise<DemoResult> {
  const { owner } = opts;
  const log = opts.log ?? (() => undefined);
  const tenant = await owner.tenant.findUnique({ where: { code: opts.tenantCode } });
  if (!tenant) throw new Error(`tenant "${opts.tenantCode}" not found (run pnpm seed first)`);
  const tenantId = tenant.id;
  const structured = resolve(opts.sampleDir, "structured");

  const campuses = await owner.campus.findMany({ where: { tenantId } });
  const campusByCode = new Map(campuses.map((c) => [c.code, c]));
  const campusOf = (sampleId: string) => {
    const c = campusByCode.get(CAMPUS_ALIASES[sampleId] ?? sampleId);
    if (!c) throw new Error(`campus ${sampleId} is not in the tenant (run pnpm import:sample first)`);
    return c;
  };

  const staffRows = records(structured, "employees.csv");
  const studentRows = records(structured, "students.csv");
  const staffProfiles = await owner.staffProfile.findMany({ where: { tenantId } });
  const studentProfiles = await owner.studentProfile.findMany({ where: { tenantId } });
  const staffPerson = new Map(staffProfiles.map((s) => [s.employeeNo, s.personId]));
  const studentPerson = new Map(studentProfiles.map((s) => [s.studentNo, s.personId]));
  if (staffPerson.size === 0 || studentPerson.size === 0) throw new Error("no staff or students in the tenant (run pnpm import:sample first)");

  // ---------------------------------------------------------------- 教学
  const term = await findOrCreate(
    () => owner.term.findFirst({ where: { tenantId, code: TERM_CODE } }),
    () =>
      owner.term.create({
        data: {
          tenantId, code: TERM_CODE, name: "2026 Spring", startDate: new Date("2026-03-01"), endDate: new Date("2026-06-30"),
          enrollOpenDate: new Date("2026-02-01"), enrollCloseDate: new Date("2026-03-15"), dropDeadline: new Date("2026-03-20"), status: "ended",
        },
      }),
  );
  const courseIds = new Map<string, string>();
  for (const [program, def] of Object.entries(PROGRAMS)) {
    const course = await findOrCreate(
      () => owner.course.findFirst({ where: { tenantId, code: def.course } }),
      () => owner.course.create({ data: { tenantId, code: def.course, name: def.name, credits: 3 } }),
    );
    courseIds.set(program, course.id);
    const major = await findOrCreate(
      () => owner.major.findFirst({ where: { tenantId, code: def.course } }),
      () => owner.major.create({ data: { tenantId, code: def.course, name: def.name, degreeType: "certificate", totalCredits: 3 } }),
    );
    const version = await findOrCreate(
      () => owner.majorVersion.findFirst({ where: { majorId: major.id } }),
      () => owner.majorVersion.create({ data: { tenantId, majorId: major.id, label: "Initial", effectiveYear: 2000, totalCredits: 3 } }),
    );
    await findOrCreate(
      () => owner.majorCourse.findFirst({ where: { versionId: version.id, courseId: course.id } }),
      () => owner.majorCourse.create({ data: { tenantId, majorId: major.id, versionId: version.id, courseId: course.id, category: "required", suggestedTerm: 1 } }),
    );
  }
  const majorByProgram = new Map<string, string>();
  for (const [program, def] of Object.entries(PROGRAMS)) majorByProgram.set(program, (await owner.major.findFirstOrThrow({ where: { tenantId, code: def.course } })).id);

  // 一个"方向 × 校区"一个班；带头老师取该校区的第一位讲师（没有就取样本里的第一位讲师）
  const instructors = staffRows.filter((r) => /instructor/i.test(r.title) && r.status === "active");
  const instructorFor = (sampleCampus: string) => (instructors.find((r) => r.campus_id === sampleCampus) ?? instructors[0]).employee_id;
  const groups = new Map<string, typeof studentRows>();
  for (const s of studentRows) {
    if (!(s.program in PROGRAMS)) continue;
    const key = `${s.program}|${s.campus_id}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const sectionOf = new Map<string, { id: string; timezone: string; assignmentIds: Map<string, string> }>();
  const assignmentRows = records(structured, "assignments.csv");
  let sections = 0, assignments = 0;
  for (const key of [...groups.keys()].sort()) {
    const [program, sampleCampus] = key.split("|");
    const campus = campusOf(sampleCampus);
    const courseId = courseIds.get(program) as string;
    const section = await findOrCreate(
      () => owner.section.findFirst({ where: { courseId, termId: term.id, number: sampleCampus } }),
      () =>
        owner.section.create({
          data: { tenantId, courseId, termId: term.id, campusId: campus.id, number: sampleCampus, name: `${PROGRAMS[program as keyof typeof PROGRAMS].name} (${campus.name})`, capacity: 30, status: "ended" },
        }),
    );
    sections++;
    const lead = staffPerson.get(instructorFor(sampleCampus)) as string;
    await findOrCreate(
      () => owner.sectionInstructor.findFirst({ where: { sectionId: section.id, personId: lead } }),
      () => owner.sectionInstructor.create({ data: { tenantId, sectionId: section.id, personId: lead, role: "lead" } }),
    );
    const group = await findOrCreate(
      () => owner.assignmentGroup.findFirst({ where: { sectionId: section.id, name: "Assignments" } }),
      () => owner.assignmentGroup.create({ data: { tenantId, sectionId: section.id, name: "Assignments", weight: 100 } }),
    );
    const ids = new Map<string, string>();
    for (const a of assignmentRows.filter((r) => r.program === program)) {
      // 样本的作业编号写在描述里（没有单独的列），后面按它找回来
      const marker = `sample:${a.assignment_id}`;
      const row = await findOrCreate(
        () => owner.assignment.findFirst({ where: { sectionId: section.id, description: marker } }),
        async () => {
          const created = await owner.assignment.create({
            data: {
              tenantId, sectionId: section.id, groupId: group.id, title: a.title, description: marker, dueDate: new Date(a.due_date),
              dueAt: endOfLocalDay(a.due_date, campus.timezone), latePolicy: DEFAULT_LATE_POLICY as never, maxScore: 100, published: true,
              publishedAt: new Date(`${a.due_date}T00:00:00Z`),
            },
          });
          await owner.rubricItem.create({ data: { tenantId, assignmentId: created.id, title: "Overall", maxPoints: 100 } });
          assignments++;
          return created;
        },
      );
      ids.set(a.assignment_id, row.id);
    }
    sectionOf.set(key, { id: section.id, timezone: campus.timezone, assignmentIds: ids });
  }
  assignments = await owner.assignment.count({ where: { tenantId, section: { termId: term.id } } });

  // 选课、提交、总评
  const subs = records(structured, "submissions.csv");
  const subsByStudent = new Map<string, typeof subs>();
  for (const r of subs) subsByStudent.set(r.student_id, [...(subsByStudent.get(r.student_id) ?? []), r]);
  let submissions = 0, enrollments = 0, finalGrades = 0;
  for (const s of studentRows) {
    if (!(s.program in PROGRAMS)) continue;
    const personId = studentPerson.get(s.student_id) as string;
    const sec = sectionOf.get(`${s.program}|${s.campus_id}`) as { id: string; assignmentIds: Map<string, string> };
    const withdrawn = s.status === "withdrawn";
    await findOrCreate(
      () => owner.studentMajor.findFirst({ where: { personId, majorId: majorByProgram.get(s.program) as string } }),
      () => owner.studentMajor.create({ data: { tenantId, personId, majorId: majorByProgram.get(s.program) as string, kind: "primary", entryYear: 2026, declaredOn: new Date("2026-02-15") } }),
    );
    let enrollment = await owner.enrollment.findFirst({ where: { sectionId: sec.id, studentPersonId: personId } });
    if (!enrollment) {
      enrollment = await owner.enrollment.create({
        data: {
          tenantId, sectionId: sec.id, studentPersonId: personId, method: "registrar", reason: "demo data", enrolledAt: new Date("2026-02-20T09:00:00Z"),
          ...(withdrawn ? { status: "withdrawn" as const, droppedAt: new Date("2026-04-01T09:00:00Z") } : {}),
        },
      });
    }
    const mine = subsByStudent.get(s.student_id) ?? [];
    const earned: Array<{ earned: number; max: number }> = [];
    for (const [sampleId, assignmentId] of sec.assignmentIds) {
      const r = mine.find((x) => x.assignment_id === sampleId);
      if (!r) {
        earned.push({ earned: 0, max: 100 });
        continue;
      }
      earned.push({ earned: Number(r.final_score), max: 100 });
      const exists = await owner.submission.findFirst({ where: { assignmentId, studentPersonId: personId } });
      if (exists) continue;
      const at = new Date(`${r.submitted_at.replace(" ", "T")}Z`);
      const late = Number(r.hours_late) > 0;
      const sub = await owner.submission.create({
        data: {
          tenantId, assignmentId, studentPersonId: personId, status: "published", submittedAt: at, isLate: late, hoursLate: Number(r.hours_late),
          rawScore: Number(r.raw_score), latePenaltyPct: Number(r.late_penalty_pct), finalScore: Number(r.final_score), gradedAt: at, publishedAt: at,
        },
      });
      const version = await owner.submissionVersion.create({ data: { tenantId, submissionId: sub.id, version: 1, submittedAt: at, isLate: late, textAnswer: "(demo submission)" } });
      void version;
      const item = await owner.rubricItem.findFirstOrThrow({ where: { assignmentId } });
      await owner.submissionScore.create({ data: { tenantId, submissionId: sub.id, rubricItemId: item.id, points: Number(r.raw_score) } });
    }
    if (!withdrawn) {
      const total = finalTotal([{ name: "Assignments", weight: 100, items: earned }]);
      const scale = gradeFor(DEFAULT_SCALE, total);
      const has = await owner.finalGrade.findFirst({ where: { enrollmentId: enrollment.id } });
      if (!has) {
        await owner.finalGrade.create({
          data: {
            tenantId, enrollmentId: enrollment.id, total, grade: scale.grade, gradePoints: scale.points, passed: scale.passing,
            breakdown: [{ name: "Assignments", weight: 100 }] as never, computedAt: new Date("2026-07-01T00:00:00Z"), publishedAt: new Date("2026-07-01T00:00:00Z"),
          },
        });
        await owner.enrollment.update({ where: { id: enrollment.id }, data: { status: "completed", passed: scale.passing } });
      }
    }
  }
  submissions = await owner.submission.count({ where: { tenantId, assignment: { section: { termId: term.id } } } });
  enrollments = await owner.enrollment.count({ where: { tenantId, section: { termId: term.id } } });
  finalGrades = await owner.finalGrade.count({ where: { tenantId } });
  log(`teaching: ${courseIds.size} courses, ${sections} sections, ${assignments} assignments, ${submissions} submissions, ${finalGrades} final grades`);

  // ---------------------------------------------------------------- 演示账号
  const accountsCsv = records(opts.sampleDir, "demo-accounts.csv");
  const password = opts.password ?? process.env.DEMO_PASSWORD ?? DEMO_PASSWORD_DEFAULT;
  const realm = realmName("tenant", tenant.code);
  let accounts = 0;
  for (const a of accountsCsv) {
    const personId = (a.subject_type === "student" ? studentPerson : staffPerson).get(a.subject_id);
    if (!personId) throw new Error(`demo account ${a.username}: no person ${a.subject_id}`);
    let account = await owner.account.findFirst({ where: { tenantId, username: a.username } });
    if (!account) {
      account = await owner.account.create({ data: { tenantId, username: a.username, email: `${a.username}@${tenant.code}.example.test`, personId, status: "active" } });
    }
    if (opts.keycloak && !account.keycloakUserId) {
      const existing = await opts.keycloak.findUser(realm, a.username);
      const userId = existing?.id ?? (await opts.keycloak.createUser(realm, { username: a.username, email: account.email ?? undefined, accountId: account.id, password }));
      if (existing) await opts.keycloak.resetPassword(realm, existing.id, password, false);
      account = await owner.account.update({ where: { id: account.id }, data: { keycloakUserId: userId } });
    }
    for (const code of demoRoles(a.role, a.title)) {
      const role = await owner.role.findFirst({ where: { tenantId, code } });
      if (!role) throw new Error(`role ${code} is missing in the tenant`);
      await owner.accountRole.upsert({ where: { accountId_roleId: { accountId: account.id, roleId: role.id } }, create: { tenantId, accountId: account.id, roleId: role.id }, update: {} });
    }
    accounts++;
  }
  log(`accounts: ${accounts} demo accounts${opts.keycloak ? " (with sign-in users)" : " (no sign-in users)"}`);

  // ---------------------------------------------------------------- 文档库
  let folders = 0, files = 0;
  if (opts.putObject) {
    const roles = new Map((await owner.role.findMany({ where: { tenantId } })).map((r) => [r.code, r.id]));
    const manifest = records(resolve(opts.sampleDir, "documents"), "manifest.csv").filter((r) => r.status === "active");
    for (const m of manifest) {
      const rule = ACCESS[m.access];
      if (!rule) throw new Error(`unknown access level ${m.access} in the sample manifest`);
      const folderName = `${DOMAIN_TITLES[m.domain] ?? m.domain} - ${rule.label}`;
      let folder = await owner.docFolder.findFirst({ where: { tenantId, parentId: null, name: folderName } });
      if (!folder) {
        const confidential = rule.classification === "confidential";
        folder = await owner.docFolder.create({ data: { tenantId, name: folderName, classification: rule.classification, inheritAcl: !confidential, logAccess: confidential } });
        const grants: Prisma.DocAclCreateManyInput[] =
          rule.grant.type === "role"
            ? (rule.grant.roles ?? []).map((code) => ({ tenantId, folderId: folder!.id, principalType: "role", principalId: roles.get(code) as string, level: "view", source: "manual" }))
            : [{ tenantId, folderId: folder.id, principalType: rule.grant.type, level: "view", source: "default" }];
        await owner.docAcl.createMany({ data: grants });
      }
      folders = await owner.docFolder.count({ where: { tenantId } });
      const fileName = m.file.split("/").pop() as string;
      if (await owner.docFile.findFirst({ where: { tenantId, folderId: folder.id, name: fileName, deletedAt: null } })) continue;
      const body = readFileSync(resolve(opts.sampleDir, "documents", m.file));
      const contentType = CONTENT_TYPES[extname(fileName).slice(1).toLowerCase()] ?? "application/octet-stream";
      const fileId = randomUUID();
      const key = `tenant/${tenantId}/library/${fileId}/v1-${fileName.replace(/[^A-Za-z0-9._-]/g, "_")}`;
      await opts.putObject(key, body, contentType);
      const file = await owner.docFile.create({ data: { id: fileId, tenantId, folderId: folder.id, name: fileName, storageKey: key, size: body.length, contentType } });
      await owner.docFileVersion.create({ data: { tenantId, fileId: file.id, version: 1, storageKey: key, size: body.length, contentType } });
      if (opts.emitLibraryEvents) await owner.outboxEvent.create({ data: { tenantId, type: "library.file_changed", payload: { fileId: file.id } } });
    }
    files = await owner.docFile.count({ where: { tenantId, deletedAt: null } });
    log(`library: ${folders} folders, ${files} files${opts.emitLibraryEvents ? " (change events queued for the AI knowledge base)" : ""}`);
  }

  return { courses: courseIds.size, sections, assignments, submissions, enrollments, finalGrades, accounts, folders, files };
}

async function findOrCreate<T>(find: () => Promise<T | null>, create: () => Promise<T>): Promise<T> {
  return (await find()) ?? (await create());
}
