// 班级的成绩：成绩构成（分组权重）、成绩册与导出、手工录分、算总评、发布最终成绩、结课后的更正。
//   - 看（成绩构成、成绩册、导出）：在数据范围内的班级，教师看自己任教的班，教务按校区；导出走同一个范围解析。
//   - 改权重、手工录分、算总评、发布：权限 + 必须是任课教师，班级结课后锁定。
//   - 结课后：教务用"更正"权限，必须填原因；改前改后记在 grade_change，并写审计日志。
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { AuditService } from "../audit/audit.service";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { withScope } from "../data-scope/scope-filter";
import { Prisma } from "../generated/prisma";
import { HrAccess } from "../hr/hr-access.service";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { pointsInput } from "./assignment-common";
import { SECTION_SCOPE } from "./edu-common";
import { GradesService } from "./grades.service";

const policySchema = z.object({ groups: z.array(z.object({ id: z.string().uuid(), weight: z.number().min(0).max(100).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, { message: "at most 2 decimals" }) })).min(1).max(20) });
const reasonSchema = z.object({ reason: z.string().trim().min(5).max(500) });

/** CSV 单元格：加引号；以 = + - @ 开头的文字前面补一个单引号，防止在表格软件里被当成公式。 */
const cell = (v: unknown): string => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s) && typeof v === "string") s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

@Controller("api/sections")
export class GradesController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly hr: HrAccess,
    private readonly audit: AuditService,
    private readonly grades: GradesService,
  ) {}

  private get db() {
    return this.tenantDb.db;
  }

  private async section(auth: AuthContext, sectionId: string, perm: string) {
    const scope = await this.hr.scope(auth, perm);
    const row = await this.db.section.findFirst({ where: withScope({ id: sectionId }, scope, SECTION_SCOPE) });
    if (!row) throw new NotFoundException();
    return row;
  }

  /** 教师写：权限 + 范围 + 任课教师；班级结课（成绩锁定）或取消后拒绝。 */
  private async editable(auth: AuthContext, sectionId: string, perm: string) {
    const row = await this.section(auth, sectionId, perm);
    if (!auth.authz.personId || !(await this.db.sectionInstructor.findFirst({ where: { sectionId, personId: auth.authz.personId } }))) throw new ForbiddenException("Only the section's instructors may do this");
    if (row.status === "ended") throw new ConflictException("The section has ended and grades are locked; a registrar can amend them with a reason");
    if (row.status === "cancelled") throw new ConflictException("The section was cancelled");
    return row;
  }

  // ------------------------------------------------------------ 成绩构成
  @Get(":id/grade-policy")
  @RequirePermissions(PERMS.eduGradeList)
  async policy(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    await this.section(auth, id, PERMS.eduGradeList);
    const { groups, assignments, problems } = await this.grades.gradebook(id);
    return { groups, assignments, problems, weightTotal: groups.reduce((s, g) => s + g.weight, 0) };
  }

  /** 设置各分组的权重；合计必须正好 100。 */
  @Put(":id/grade-policy")
  @RequirePermissions(PERMS.eduGradeEdit)
  async setPolicy(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(policySchema, body);
    await this.editable(auth, id, PERMS.eduGradeEdit);
    const existing = await this.db.assignmentGroup.findMany({ where: { sectionId: id } });
    const ids = new Set(existing.map((g) => g.id));
    if (input.groups.some((g) => !ids.has(g.id)) || new Set(input.groups.map((g) => g.id)).size !== input.groups.length) throw new BadRequestException("Unknown or repeated group");
    const given = new Map(input.groups.map((g) => [g.id, g.weight]));
    const total = existing.reduce((s, g) => s.plus(given.get(g.id) ?? Number(g.weight)), new Prisma.Decimal(0));
    if (!total.equals(100)) throw new BadRequestException(`Weights add up to ${total.toString()}%, not 100%`);
    await this.tenantDb.transaction(async (tx) => {
      for (const g of input.groups) await tx.assignmentGroup.update({ where: { id: g.id }, data: { weight: new Prisma.Decimal(g.weight) } });
    });
    await this.audit.record(auth.accountId, "grades.policy", "section", id, { weights: input.groups });
    return this.policy(auth, id);
  }

  // ------------------------------------------------------------ 成绩册
  @Get(":id/gradebook")
  @RequirePermissions(PERMS.eduGradeList)
  async gradebook(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    await this.section(auth, id, PERMS.eduGradeList);
    return this.grades.gradebook(id);
  }

  @Get(":id/gradebook.csv")
  @RequirePermissions(PERMS.eduGradeList)
  async gradebookCsv(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Res() res: Response) {
    const section = await this.section(auth, id, PERMS.eduGradeList); // 同一个范围解析
    const book = await this.grades.gradebook(id);
    const head = ["Student no.", "Name", ...book.assignments.map((a) => `${a.title} (/${a.maxScore})`), "Total", "Grade", "Final status"];
    const lines = [head.map(cell).join(",")];
    for (const s of book.students) {
      lines.push([s.studentNo, s.fullName, ...book.assignments.map((a) => (s.cells[a.id].points ?? (s.cells[a.id].state === "missing" ? "missing" : ""))), s.total, s.grade, s.final ? (s.final.published ? "published" : "draft") : ""].map(cell).join(","));
    }
    await this.audit.record(auth.accountId, "grades.export", "section", id, { rows: book.students.length });
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="gradebook-${section.name.replace(/[^A-Za-z0-9._-]/g, "_")}.csv"`);
    res.send(`${String.fromCharCode(0xfeff)}${lines.join("\r\n")}\r\n`);
  }

  /** 手工录分（没有提交的作业，或补录）：只给"已发布"的作业；学生已有已发布的提交分数就不能再手工录。points 为 null 是删除。 */
  @Put(":id/assignments/:assignmentId/manual-scores/:studentId")
  @RequirePermissions(PERMS.eduGradeEdit)
  async manualScore(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Param("assignmentId", ParseUUIDPipe) assignmentId: string, @Param("studentId", ParseUUIDPipe) studentId: string, @Body() body: unknown) {
    const { points } = parse(z.object({ points: pointsInput.nullable() }), body);
    await this.editable(auth, id, PERMS.eduGradeEdit);
    const a = await this.db.assignment.findFirst({ where: { id: assignmentId, sectionId: id } });
    if (!a) throw new NotFoundException();
    if (!a.published) throw new ConflictException("Publish the assignment first");
    if (!(await this.db.enrollment.findFirst({ where: { sectionId: id, studentPersonId: studentId, status: { in: ["enrolled", "completed"] } } }))) throw new BadRequestException("The student is not in this section");
    if (await this.db.submission.findFirst({ where: { assignmentId, studentPersonId: studentId, status: "published" } })) throw new ConflictException("This student's submission already has a published score");
    if (points === null) {
      await this.db.manualGrade.deleteMany({ where: { assignmentId, studentPersonId: studentId } });
      return { assignmentId, studentId, points: null };
    }
    if (points > Number(a.maxScore)) throw new BadRequestException(`The score is out of ${Number(a.maxScore)}`);
    await this.db.manualGrade.upsert({
      where: { assignmentId_studentPersonId: { assignmentId, studentPersonId: studentId } },
      create: { tenantId: auth.tenantId, assignmentId, studentPersonId: studentId, points: new Prisma.Decimal(points), enteredBy: auth.accountId },
      update: { points: new Prisma.Decimal(points), enteredBy: auth.accountId },
    });
    return { assignmentId, studentId, points };
  }

  // ------------------------------------------------------------ 最终成绩
  @Post(":id/final-grades/calculate")
  @RequirePermissions(PERMS.eduGradeEdit)
  async calculate(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    await this.editable(auth, id, PERMS.eduGradeEdit);
    return this.grades.calculate(id, auth.accountId, { kind: "calculate" });
  }

  @Post(":id/final-grades/publish")
  @RequirePermissions(PERMS.eduGradeEdit)
  async publish(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    await this.editable(auth, id, PERMS.eduGradeEdit);
    return this.grades.publish(id, auth.accountId);
  }

  /** 结课后重算并发布（教务）：必须填原因；有变化的每个学生记改前改后。 */
  @Post(":id/final-grades/recalculate")
  @RequirePermissions(PERMS.eduGradeAmend)
  async recalculate(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = parse(reasonSchema, body);
    await this.section(auth, id, PERMS.eduGradeAmend);
    const calc = await this.grades.calculate(id, auth.accountId, { kind: "amend_recalc", reason });
    const published = await this.grades.publish(id, auth.accountId);
    return { ...calc, ...published };
  }

  /** 更正一个学生的最终成绩（教务）：给出新总评和原因。 */
  @Put(":id/final-grades/:enrollmentId")
  @RequirePermissions(PERMS.eduGradeAmend)
  async amend(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Param("enrollmentId", ParseUUIDPipe) enrollmentId: string, @Body() body: unknown) {
    const input = parse(reasonSchema.extend({ total: z.number().min(0).max(100) }), body);
    await this.section(auth, id, PERMS.eduGradeAmend);
    return this.grades.amend(id, enrollmentId, Math.round(input.total * 10) / 10, input.reason, auth.accountId);
  }

  @Get(":id/grade-changes")
  @RequirePermissions(PERMS.eduGradeList)
  async changes(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    await this.section(auth, id, PERMS.eduGradeList);
    const enrollments = await this.db.enrollment.findMany({ where: { sectionId: id }, select: { id: true, studentPersonId: true } });
    const rows = await this.db.gradeChange.findMany({ where: { enrollmentId: { in: enrollments.map((e) => e.id) } }, orderBy: { changedAt: "desc" } });
    const who = new Map(enrollments.map((e) => [e.id, e.studentPersonId]));
    return rows.map((r) => ({ id: r.id, enrollmentId: r.enrollmentId, studentPersonId: who.get(r.enrollmentId), kind: r.kind, before: r.before, after: r.after, reason: r.reason, changedBy: r.changedBy, changedAt: r.changedAt }));
  }
}
