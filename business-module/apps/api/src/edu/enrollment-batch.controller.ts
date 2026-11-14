// 批量安排选课（教务）：按"专业 + 入学年份 + 校区"选出一批学生，把他们选进某学期某门课的班级。
// 每个学生放进"自己校区、开放中、剩余名额最多"的班级；规则和单个代选完全相同（同一个选课服务），
// 超员、先修未满足、时间冲突、窗口外要确认并填原因；先"预览"看每个人会怎样，再正式执行。
// 一批最多 500 人；逐人处理，一个人失败不影响其他人；正式执行写一条汇总审计，每个人的代选另有各自的留痕。
import { BadRequestException, Body, Controller, Post } from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { AuditService } from "../audit/audit.service";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { withScope } from "../data-scope/scope-filter";
import { HrAccess, STUDENT_SCOPE } from "../hr/hr-access.service";
import { assertVisible } from "../tenancy/owned";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { SECTION_SCOPE } from "./edu-common";
import { EnrollmentService } from "./enrollment.service";

export const MAX_BATCH = 500;

const schema = z
  .object({
    termId: z.string().uuid(),
    courseId: z.string().uuid(),
    majorId: z.string().uuid(),
    entryYear: z.number().int().min(1900).max(2200).optional(),
    campusId: z.string().uuid().optional(),
    confirm: z.array(z.enum(["capacity", "prerequisite", "conflict", "window", "retake"])).optional(),
    reason: z.string().trim().max(500).optional(),
    dryRun: z.boolean().default(true),
  })
  .strict();

interface Row {
  studentId: string;
  fullName: string | null;
  studentNo: string | null;
  sectionId: string | null;
  sectionName: string | null;
  ok: boolean;
  code?: string;
  violations?: string[];
  message?: string;
}

@Controller("api/enrollment-batches")
export class EnrollmentBatchController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly hr: HrAccess,
    private readonly audit: AuditService,
    private readonly enrollments: EnrollmentService,
  ) {}

  private get db() {
    return this.tenantDb.db;
  }

  @Post()
  @RequirePermissions(PERMS.eduEnrollmentAdd)
  async run(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(schema, body);
    await assertVisible(this.db.term, [input.termId], "term");
    await assertVisible(this.db.course, [input.courseId], "course");
    await assertVisible(this.db.major, [input.majorId], "major");
    if (input.campusId) await assertVisible(this.db.campus, [input.campusId], "campus");

    // 候选班级：该学期该课程、开放中、在操作者的班级数据范围内
    const sectionScope = await this.hr.scope(auth, PERMS.eduEnrollmentAdd);
    const sections = await this.db.section.findMany({ where: withScope({ termId: input.termId, courseId: input.courseId, status: "open" }, sectionScope, SECTION_SCOPE), orderBy: { name: "asc" } });
    const seated = new Map((await this.db.enrollment.groupBy({ by: ["sectionId"], where: { sectionId: { in: sections.map((s) => s.id) }, status: "enrolled" }, _count: { _all: true } })).map((g) => [g.sectionId, g._count._all]));
    const planned = new Map<string, number>();

    // 学生：申报了这个专业（有效）、入学年份符合、校区符合、在操作者的学员范围内、学籍在读
    const declared = await this.db.studentMajor.findMany({ where: { majorId: input.majorId, active: true, ...(input.entryYear ? { entryYear: input.entryYear } : {}) } });
    const studentScope = await this.hr.scope(auth, PERMS.eduEnrollmentAdd);
    const people = await this.db.person.findMany({ where: withScope({ id: { in: declared.map((d) => d.personId) }, student: { isNot: null } }, studentScope, STUDENT_SCOPE), orderBy: { fullName: "asc" } });
    const profiles = new Map((await this.db.studentProfile.findMany({ where: { personId: { in: people.map((p) => p.id) } } })).map((p) => [p.personId, p]));
    const chosen = people.filter((p) => !input.campusId || profiles.get(p.id)?.campusId === input.campusId);
    if (chosen.length > MAX_BATCH) throw new BadRequestException(`A batch can hold at most ${MAX_BATCH} students (this selection has ${chosen.length}); narrow it by entry year or campus`);

    const rows: Row[] = [];
    for (const person of chosen) {
      const profile = profiles.get(person.id);
      const base = { studentId: person.id, fullName: person.fullName, studentNo: profile?.studentNo ?? null };
      // 自己校区的班里，剩余名额最多的；没有自己校区的班就没法安排
      const mine = sections.filter((s) => s.campusId === profile?.campusId);
      const free = (id: string, cap: number) => cap - (seated.get(id) ?? 0) - (planned.get(id) ?? 0);
      const pick = [...mine].sort((a, b) => free(b.id, b.capacity) - free(a.id, a.capacity))[0];
      if (!pick) {
        rows.push({ ...base, sectionId: null, sectionName: null, ok: false, code: "NO_SECTION", message: "No open section of this course at the student's campus" });
        continue;
      }
      try {
        await this.enrollments.enroll({ sectionId: pick.id, studentPersonId: person.id, method: "registrar", actorAccountId: auth.accountId, confirm: input.confirm, reason: input.reason, dryRun: input.dryRun });
        planned.set(pick.id, (planned.get(pick.id) ?? 0) + 1);
        rows.push({ ...base, sectionId: pick.id, sectionName: pick.name, ok: true });
      } catch (err) {
        const res = (err as { getResponse?: () => unknown }).getResponse?.() as { code?: string; message?: string; violations?: string[] } | undefined;
        if (!res || typeof res !== "object") throw err;
        rows.push({ ...base, sectionId: pick.id, sectionName: pick.name, ok: false, code: res.code, violations: res.violations, message: res.message });
      }
    }
    const summary = {
      selected: rows.length,
      ok: rows.filter((r) => r.ok).length,
      needConfirmation: rows.filter((r) => r.code === "CONFIRMATION_REQUIRED").length,
      blocked: rows.filter((r) => !r.ok && r.code !== "CONFIRMATION_REQUIRED").length,
    };
    if (!input.dryRun) await this.audit.record(auth.accountId, "enrollment.batch", "course", input.courseId, { termId: input.termId, majorId: input.majorId, entryYear: input.entryYear ?? null, campusId: input.campusId ?? null, ...summary, overrides: input.confirm ?? [] });
    return { dryRun: input.dryRun, summary, rows };
  }
}
