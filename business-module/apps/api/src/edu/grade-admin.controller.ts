// 成绩的管理一侧：成绩等级表（租户级）、学生成绩单（查看、生成正式版）、仪表板（只在可见范围内汇总）。
import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { AuditService } from "../audit/audit.service";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { withScope } from "../data-scope/scope-filter";
import { Prisma } from "../generated/prisma";
import { HrAccess, STUDENT_SCOPE } from "../hr/hr-access.service";
import { requireTenant } from "../tenancy/request-scope";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { SECTION_SCOPE } from "./edu-common";
import { DEFAULT_SCALE, scaleProblems } from "./grade-calc";
import { GradesService } from "./grades.service";
import { TranscriptService } from "./transcript.service";

const scaleSchema = z.object({
  items: z.array(z.object({ grade: z.string().trim().min(1).max(5), minPercent: z.number().min(0).max(100), points: z.number().min(0).max(10), passing: z.boolean() })).min(2).max(20),
});

@Controller("api")
export class GradeAdminController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly hr: HrAccess,
    private readonly audit: AuditService,
    private readonly grades: GradesService,
    private readonly transcripts: TranscriptService,
  ) {}

  private get db() {
    return this.tenantDb.db;
  }

  // ------------------------------------------------------------ 等级表
  @Get("grading-scale")
  @RequirePermissions(PERMS.eduScaleList)
  async scale() {
    const stored = await this.db.gradingScaleItem.count();
    return { isDefault: stored === 0, items: await this.grades.scale() };
  }

  /** 整体替换等级表。已发布的最终成绩不变（已存的等级和绩点是当时的结果）；以后重算按新表。 */
  @Put("grading-scale")
  @RequirePermissions(PERMS.eduScaleEdit)
  async setScale(@Auth() auth: AuthContext, @Body() body: unknown) {
    const { items } = parse(scaleSchema, body);
    const problems = scaleProblems(items);
    if (problems.length) throw new BadRequestException(problems.join("; "));
    await this.tenantDb.transaction(async (tx) => {
      await tx.gradingScaleItem.deleteMany({});
      await tx.gradingScaleItem.createMany({ data: items.map((i) => ({ tenantId: auth.tenantId, grade: i.grade, minPercent: new Prisma.Decimal(i.minPercent), points: new Prisma.Decimal(i.points), passing: i.passing })) });
    });
    await this.audit.record(auth.accountId, "grading_scale.update", "tenant", auth.tenantId, { items });
    return this.scale();
  }

  @Post("grading-scale/reset")
  @RequirePermissions(PERMS.eduScaleEdit)
  async resetScale(@Auth() auth: AuthContext) {
    await this.db.gradingScaleItem.deleteMany({});
    await this.audit.record(auth.accountId, "grading_scale.reset", "tenant", auth.tenantId, { items: DEFAULT_SCALE });
    return this.scale();
  }

  // ------------------------------------------------------------ 成绩单
  private async student(auth: AuthContext, personId: string, perm: string) {
    const scope = await this.hr.scope(auth, perm);
    const row = await this.db.person.findFirst({ where: withScope({ id: personId, student: { isNot: null } }, scope, STUDENT_SCOPE), select: { id: true } });
    if (!row) throw new NotFoundException();
  }

  @Get("transcripts/:personId")
  @RequirePermissions(PERMS.eduTranscriptList)
  async transcript(@Auth() auth: AuthContext, @Param("personId", ParseUUIDPipe) studentId: string) {
    await this.student(auth, studentId, PERMS.eduTranscriptList);
    const issues = await this.db.transcriptIssue.findMany({ where: { studentPersonId: studentId }, orderBy: { generatedAt: "desc" }, take: 50 });
    return { transcript: await this.transcripts.build(studentId), issues: issues.map((i) => ({ id: i.id, docNumber: i.docNumber, version: i.version, generatedAt: i.generatedAt, generatedBy: i.generatedBy, verifyUrl: this.transcripts.verifyUrl(requireTenant("list issues").code, i.verifyToken), verifiable: !!i.contentHash, revokedAt: i.revokedAt, revokeReason: i.revokeReason })) };
  }

  /** 作废一份已生成的成绩单（比如发现生成错了、学生信息有误）：验真页立刻显示"已作废"。不能撤销作废。 */
  @Post("transcripts/issues/:issueId/revoke")
  @RequirePermissions(PERMS.eduTranscriptIssue)
  async revoke(@Auth() auth: AuthContext, @Param("issueId", ParseUUIDPipe) issueId: string, @Body() body: unknown) {
    const { reason } = parse(z.object({ reason: z.string().trim().min(1).max(500) }).strict(), body);
    const issue = await this.db.transcriptIssue.findUnique({ where: { id: issueId } });
    if (!issue) throw new NotFoundException();
    await this.student(auth, issue.studentPersonId, PERMS.eduTranscriptIssue);
    const r = await this.transcripts.revoke(issueId, auth.accountId, reason);
    await this.audit.record(auth.accountId, "transcript.revoke", "person", issue.studentPersonId, { docNumber: issue.docNumber, reason });
    return { id: r.id, docNumber: r.docNumber, revokedAt: r.revokedAt };
  }

  /** 生成正式版成绩单（PDF，带唯一编号，写生成记录和审计日志）。毕业、退学的学生也可以由教务生成。 */
  @Post("transcripts/:personId/formal")
  @RequirePermissions(PERMS.eduTranscriptIssue)
  async formal(@Auth() auth: AuthContext, @Param("personId", ParseUUIDPipe) studentId: string, @Res() res: Response) {
    await this.student(auth, studentId, PERMS.eduTranscriptIssue);
    const t = await this.transcripts.build(studentId);
    const tenant = await this.db.tenant.findUnique({ where: { id: auth.tenantId } });
    const institution = tenant?.name ?? "Institution";
    const issue = await this.transcripts.issue(studentId, "formal", auth.accountId, t, institution);
    const pdf = await this.transcripts.pdf(t, { version: "formal", docNumber: issue.docNumber, generatedAt: issue.generatedAt, institution, verify: { url: issue.verifyUrl, fingerprint: issue.fingerprint } });
    await this.audit.record(auth.accountId, "transcript.issue_formal", "person", studentId, { docNumber: issue.docNumber });
    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-disposition", `attachment; filename="${issue.docNumber}.pdf"`);
    res.send(pdf);
  }

  // ------------------------------------------------------------ 仪表板
  /**
   * 总览：只统计"在我的数据范围内的班级"。学员数是这些班里的不同在读学生；
   * 作业完成率 = 已提交数 ÷（已发布作业数 × 班内学生数）；平均分是已发布提交的得分率；迟交率 = 迟交数 ÷ 提交数。
   */
  @Get("dashboard/overview")
  @RequirePermissions(PERMS.eduDashboardView)
  async overview(@Auth() auth: AuthContext) {
    const scope = await this.hr.scope(auth, PERMS.eduDashboardView);
    const sections = await this.db.section.findMany({ where: withScope({ status: { in: ["open", "in_progress", "ended"] } }, scope, SECTION_SCOPE), include: { campus: true } });
    const ids = sections.map((s) => s.id);
    const [enrollments, assignments, subs] = await Promise.all([
      this.db.enrollment.findMany({ where: { sectionId: { in: ids }, status: { in: ["enrolled", "completed"] } } }),
      this.db.assignment.findMany({ where: { sectionId: { in: ids }, published: true } }),
      this.db.submission.findMany({ where: { assignment: { sectionId: { in: ids }, published: true } }, include: { assignment: true } }),
    ]);
    const campuses = new Map<string, { campusId: string; campus: string; sections: number; inProgress: number; students: Set<string>; expected: number; submitted: number; late: number; pctSum: number; pctN: number }>();
    for (const s of sections) {
      if (!campuses.has(s.campusId)) campuses.set(s.campusId, { campusId: s.campusId, campus: s.campus.name, sections: 0, inProgress: 0, students: new Set(), expected: 0, submitted: 0, late: 0, pctSum: 0, pctN: 0 });
      const c = campuses.get(s.campusId)!;
      c.sections++;
      if (s.status === "in_progress") c.inProgress++;
      const enrolled = enrollments.filter((e) => e.sectionId === s.id);
      enrolled.forEach((e) => c.students.add(e.studentPersonId));
      c.expected += assignments.filter((a) => a.sectionId === s.id && !a.manualOnly).length * enrolled.length;
    }
    const campusOf = new Map(sections.map((s) => [s.id, s.campusId]));
    for (const sub of subs) {
      const c = campuses.get(campusOf.get(sub.assignment.sectionId)!);
      if (!c) continue;
      c.submitted++;
      if (sub.isLate) c.late++;
      if (sub.status === "published" && Number(sub.assignment.maxScore) > 0) {
        c.pctSum += (Number(sub.finalScore ?? 0) / Number(sub.assignment.maxScore)) * 100;
        c.pctN++;
      }
    }
    const rows = [...campuses.values()].map((c) => ({
      campusId: c.campusId, campus: c.campus, sections: c.sections, inProgressSections: c.inProgress, students: c.students.size,
      completionRate: c.expected ? Math.round((c.submitted / c.expected) * 1000) / 10 : null, averageScore: c.pctN ? Math.round((c.pctSum / c.pctN) * 10) / 10 : null, lateRate: c.submitted ? Math.round((c.late / c.submitted) * 1000) / 10 : null,
    }));
    const allStudents = new Set(enrollments.map((e) => e.studentPersonId));
    const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0);
    return { campuses: rows, totals: { sections: sum((r) => r.sections), inProgressSections: sum((r) => r.inProgressSections), students: allStudents.size } };
  }

  /** 教师的班级分析：成绩分布（每 10 分一档，用总评）和薄弱作业（平均得分率最低的几次）。 */
  @Get("dashboard/sections/:id")
  @RequirePermissions(PERMS.eduDashboardView)
  async sectionAnalysis(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const scope = await this.hr.scope(auth, PERMS.eduDashboardView);
    if (!(await this.db.section.findFirst({ where: withScope({ id }, scope, SECTION_SCOPE), select: { id: true } }))) throw new NotFoundException();
    const book = await this.grades.gradebook(id);
    const buckets = Array.from({ length: 10 }, (_, i) => ({ from: i * 10, to: i === 9 ? 100 : i * 10 + 9.9, count: 0 }));
    for (const s of book.students) if (s.total !== null) buckets[Math.min(9, Math.floor(s.total / 10))].count++;
    const weak = book.assignments
      .map((a) => {
        const scored = book.students.map((s) => s.cells[a.id]).filter((c) => c.points !== null);
        return { assignmentId: a.id, title: a.title, averagePercent: scored.length && a.maxScore > 0 ? Math.round((scored.reduce((x, c) => x + (c.points ?? 0), 0) / scored.length / a.maxScore) * 1000) / 10 : null, scored: scored.length };
      })
      .filter((a) => a.averagePercent !== null)
      .sort((a, b) => a.averagePercent! - b.averagePercent!)
      .slice(0, 3);
    return { students: book.students.length, distribution: buckets, weakAssignments: weak, ready: book.problems.length === 0 };
  }
}
