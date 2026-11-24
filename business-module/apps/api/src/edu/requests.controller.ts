// 学生申请（教师和教务一侧）：看、批准、驳回。
//   - 看：权限 + 数据范围（教师看自己任教的班，教务按校区）。
//   - 延期：权限 + 范围内的任课教师或教务可以批（天数可以改小改大，1–3 天）；批准后和手工设延期完全一样。
//   - 复评：批准要改分，所以还需要"结课后改成绩"权限（教务）；教师只能看和驳回。批准必须给新的总评和原因，改前改后记在成绩改动记录里。
//   - 驳回必须写理由；每次处理都通知学生并写审计日志；已处理的申请不能再处理。
import { ParamsService } from "../sysdata/params.service";
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { AuditService } from "../audit/audit.service";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { withScope } from "../data-scope/scope-filter";
import { HrAccess } from "../hr/hr-access.service";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { effectiveDeadline, recomputeLateness } from "./assignment-common";
import { SECTION_SCOPE } from "./edu-common";
import { GradesService } from "./grades.service";
import { OutboxService } from "./outbox.service";

const decideSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    note: z.string().trim().min(3).max(500),
    /** 延期：批准的天数，不给就按申请的天数 */
    days: z.number().int().min(1).max(30).optional(),
    /** 复评批准：新的总评 */
    total: z.number().min(0).max(100).optional(),
  })
  .strict();

@Controller("api/requests")
export class RequestsController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly hr: HrAccess,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly grades: GradesService,
    private readonly params: ParamsService,
  ) {}

  private get db() {
    return this.tenantDb.db;
  }

  private async visibleSectionIds(auth: AuthContext, perm: string): Promise<string[]> {
    const scope = await this.hr.scope(auth, perm);
    const rows = await this.db.section.findMany({ where: withScope({}, scope, SECTION_SCOPE), select: { id: true } });
    return rows.map((r) => r.id);
  }

  @Get()
  @RequirePermissions(PERMS.eduRequestList)
  async list(@Auth() auth: AuthContext, @Query("status") status?: string) {
    if (status !== undefined && !["pending", "approved", "rejected", "withdrawn"].includes(status)) throw new BadRequestException("Invalid status");
    const ids = await this.visibleSectionIds(auth, PERMS.eduRequestList);
    const rows = await this.db.studentRequest.findMany({ where: { sectionId: { in: ids }, ...(status ? { status } : {}) }, orderBy: { createdAt: "desc" }, take: 200 });
    const [sections, people, assignments, finals] = await Promise.all([
      this.db.section.findMany({ where: { id: { in: rows.map((r) => r.sectionId) } }, select: { id: true, name: true } }),
      this.db.person.findMany({ where: { id: { in: rows.map((r) => r.studentPersonId) } }, select: { id: true, fullName: true } }),
      this.db.assignment.findMany({ where: { id: { in: rows.flatMap((r) => (r.assignmentId ? [r.assignmentId] : [])) } }, select: { id: true, title: true, dueAt: true } }),
      this.db.finalGrade.findMany({ where: { enrollmentId: { in: rows.flatMap((r) => (r.enrollmentId ? [r.enrollmentId] : [])) } } }),
    ]);
    return rows.map((r) => {
      const a = assignments.find((x) => x.id === r.assignmentId);
      const f = finals.find((x) => x.enrollmentId === r.enrollmentId);
      return {
        id: r.id, kind: r.kind, status: r.status, sectionId: r.sectionId, section: sections.find((s) => s.id === r.sectionId)?.name ?? "",
        studentPersonId: r.studentPersonId, student: people.find((p) => p.id === r.studentPersonId)?.fullName ?? "",
        assignment: a ? { id: a.id, title: a.title, dueAt: a.dueAt } : null, days: r.days,
        currentGrade: f ? { total: Number(f.total), grade: f.grade } : null,
        reason: r.reason, decisionNote: r.decisionNote, decidedBy: r.decidedBy, decidedAt: r.decidedAt, result: r.result, createdAt: r.createdAt,
      };
    });
  }

  @Post(":id/decide")
  @RequirePermissions(PERMS.eduRequestDecide)
  async decide(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(decideSchema, body);
    if (input.days !== undefined) await this.params.assertExtensionDays(input.days);
    const ids = await this.visibleSectionIds(auth, PERMS.eduRequestDecide);
    const req = await this.db.studentRequest.findFirst({ where: { id, sectionId: { in: ids } } });
    if (!req) throw new NotFoundException();
    if (req.status !== "pending") throw new ConflictException({ code: "NOT_PENDING", message: `The request is already ${req.status}` });
    const approve = input.decision === "approve";
    if (req.kind === "grade_appeal" && approve) {
      if (!auth.authz.perms.includes(PERMS.eduGradeAmend)) throw new ForbiddenException("Changing a published grade needs the grade amendment permission");
      if (input.total === undefined) throw new BadRequestException("Give the new total to approve a grade appeal");
      if (input.note.length < 5) throw new BadRequestException("The note must be at least 5 characters");
    }
    // 先占住这条申请（待处理 → 已处理），并发的两次处理只有一次成功
    const claim = await this.db.studentRequest.updateMany({ where: { id, status: "pending" }, data: { status: approve ? "approved" : "rejected", decisionNote: input.note, decidedBy: auth.accountId, decidedAt: new Date() } });
    if (!claim.count) throw new ConflictException({ code: "NOT_PENDING", message: "The request was just handled by someone else" });
    let result: Record<string, unknown> | null = null;
    try {
      if (approve) result = req.kind === "extension" ? await this.grantExtension(auth, req, input.days ?? req.days ?? 1, input.note) : await this.amendGrade(auth, req, input.total!, input.note);
    } catch (e) {
      await this.db.studentRequest.updateMany({ where: { id }, data: { status: "pending", decisionNote: null, decidedBy: null, decidedAt: null } });
      throw e;
    }
    if (result) await this.db.studentRequest.update({ where: { id }, data: { result: result as never } });
    await this.outbox.emit("request.decided", { requestId: id });
    await this.audit.record(auth.accountId, "request.decide", "section", req.sectionId, { requestId: id, kind: req.kind, decision: input.decision, note: input.note, result });
    return { id, status: approve ? "approved" : "rejected", result };
  }

  private async grantExtension(auth: AuthContext, req: { sectionId: string; assignmentId: string | null; studentPersonId: string }, days: number, note: string) {
    const a = await this.db.assignment.findFirst({ where: { id: req.assignmentId ?? "", sectionId: req.sectionId } });
    if (!a) throw new NotFoundException();
    const member = await this.db.enrollment.findFirst({ where: { sectionId: req.sectionId, studentPersonId: req.studentPersonId, status: { in: ["enrolled", "completed"] } } });
    if (!member) throw new BadRequestException("The student is not in this section");
    const mine = await this.db.submission.findFirst({ where: { assignmentId: a.id, studentPersonId: req.studentPersonId } });
    if (mine && mine.status !== "submitted") throw new ConflictException("This submission is already being graded");
    await this.tenantDb.transaction(async (tx) => {
      await tx.assignmentExtension.upsert({
        where: { assignmentId_studentPersonId: { assignmentId: a.id, studentPersonId: req.studentPersonId } },
        create: { tenantId: auth.tenantId, assignmentId: a.id, studentPersonId: req.studentPersonId, days, reason: `Student request: ${note}`, grantedBy: auth.accountId },
        update: { days, reason: `Student request: ${note}`, grantedBy: auth.accountId },
      });
      await recomputeLateness(tx, a);
    });
    return { days, effectiveDeadline: effectiveDeadline(a.dueAt, days) };
  }

  private async amendGrade(auth: AuthContext, req: { sectionId: string; enrollmentId: string | null }, total: number, note: string) {
    const before = await this.db.finalGrade.findUnique({ where: { enrollmentId: req.enrollmentId ?? "" } });
    if (!before) throw new ConflictException("The student has no final grade");
    const after = await this.grades.amend(req.sectionId, req.enrollmentId!, Math.round(total * 10) / 10, `Grade appeal: ${note}`, auth.accountId);
    return { before: { total: Number(before.total), grade: before.grade }, after: { total: after.total, grade: after.grade } };
  }
}
