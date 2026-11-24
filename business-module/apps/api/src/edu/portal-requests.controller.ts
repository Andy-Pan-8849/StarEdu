// 学生申请（学生一侧）：成绩复评、作业延期。
//   - 复评：只针对已发布的最终成绩，发布后 N 天内（参数 edu.appeal.windowDays，缺省 14）；同一份成绩同时只有一条待处理，最多申请 M 次（参数 edu.appeal.maxPerCourse，缺省 2）（撤回的不算）。
//   - 延期：只针对已发布、截止还没到的作业；该学生还没被批改；不能比现有延期更短；同一次作业同时只有一条待处理。
//   - 学生可以在处理之前撤回；每次提交通知任课教师。
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { AuditService } from "../audit/audit.service";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { effectiveDeadline } from "./assignment-common";
import { OutboxService } from "./outbox.service";
import { ParamsService } from "../sysdata/params.service";

const DAY_MS = 86_400_000;

const submitSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("grade_appeal"), enrollmentId: z.string().uuid(), reason: z.string().trim().min(10).max(1000) }).strict(),
  z.object({ kind: z.literal("extension"), assignmentId: z.string().uuid(), days: z.number().int().min(1).max(30), reason: z.string().trim().min(3).max(500) }).strict(),
]);

@Controller("api/portal/requests")
export class PortalRequestsController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly params: ParamsService,
  ) {}

  /** 复评窗口天数和每门课最多复评次数：租户可在"参数"里调整。 */
  private async limits() {
    return { windowDays: await this.params.int("edu.appeal.windowDays"), maxAppeals: await this.params.int("edu.appeal.maxPerCourse") };
  }

  private get db() {
    return this.tenantDb.db;
  }

  private async me(auth: AuthContext): Promise<string> {
    const personId = auth.authz.personId;
    const profile = personId ? await this.db.studentProfile.findFirst({ where: { personId } }) : null;
    if (!personId || !profile) throw new ForbiddenException("This area is for students");
    return personId;
  }

  /** 我的申请，新的在前。 */
  @Get()
  @RequirePermissions(PERMS.portalRequestList)
  async list(@Auth() auth: AuthContext) {
    const personId = await this.me(auth);
    const rows = await this.db.studentRequest.findMany({ where: { studentPersonId: personId }, orderBy: { createdAt: "desc" } });
    return this.describe(rows);
  }

  /** 现在可以申请的：已发布成绩还在窗口内的班级，和截止未到的作业。 */
  @Get("options")
  @RequirePermissions(PERMS.portalRequestList)
  async options(@Auth() auth: AuthContext) {
    const personId = await this.me(auth);
    const { windowDays, maxAppeals } = await this.limits();
    const maxDays = await this.params.int("edu.extension.maxDays");
    const now = new Date();
    const [enrollments, pending, all] = await Promise.all([
      this.db.enrollment.findMany({ where: { studentPersonId: personId, status: { in: ["enrolled", "completed"] } } }),
      this.db.studentRequest.findMany({ where: { studentPersonId: personId, status: "pending" } }),
      this.db.studentRequest.findMany({ where: { studentPersonId: personId, kind: "grade_appeal", status: { not: "withdrawn" } } }),
    ]);
    const sections = await this.db.section.findMany({ where: { id: { in: enrollments.map((e) => e.sectionId) } }, select: { id: true, name: true, status: true } });
    const sectionName = new Map(sections.map((s) => [s.id, s.name]));
    const finals = await this.db.finalGrade.findMany({ where: { enrollmentId: { in: enrollments.map((e) => e.id) }, publishedAt: { not: null } } });
    const pendingAppeal = new Set(pending.filter((p) => p.kind === "grade_appeal").map((p) => p.enrollmentId));
    const appeals = finals
      .filter((f) => f.publishedAt && now.getTime() <= f.publishedAt.getTime() + windowDays * DAY_MS && !pendingAppeal.has(f.enrollmentId) && all.filter((a) => a.enrollmentId === f.enrollmentId).length < maxAppeals)
      .map((f) => {
        const e = enrollments.find((x) => x.id === f.enrollmentId)!;
        return { enrollmentId: f.enrollmentId, section: sectionName.get(e.sectionId) ?? "", total: Number(f.total), grade: f.grade, closesAt: new Date(f.publishedAt!.getTime() + windowDays * DAY_MS) };
      });
    const active = enrollments.filter((e) => e.status === "enrolled" && sections.find((s) => s.id === e.sectionId)?.status !== "ended" && sections.find((s) => s.id === e.sectionId)?.status !== "cancelled");
    const assignments = await this.db.assignment.findMany({ where: { sectionId: { in: active.map((e) => e.sectionId) }, published: true, manualOnly: false }, orderBy: { dueAt: "asc" } });
    const [exts, subs] = await Promise.all([
      this.db.assignmentExtension.findMany({ where: { studentPersonId: personId, assignmentId: { in: assignments.map((a) => a.id) } } }),
      this.db.submission.findMany({ where: { studentPersonId: personId, assignmentId: { in: assignments.map((a) => a.id) } }, select: { assignmentId: true, status: true } }),
    ]);
    const pendingExt = new Set(pending.filter((p) => p.kind === "extension").map((p) => p.assignmentId));
    const extensions = assignments
      .filter((a) => {
        const ext = exts.find((x) => x.assignmentId === a.id);
        const sub = subs.find((x) => x.assignmentId === a.id);
        return now < effectiveDeadline(a.dueAt, ext?.days) && (ext?.days ?? 0) < maxDays && !pendingExt.has(a.id) && (!sub || sub.status === "submitted");
      })
      .map((a) => ({ assignmentId: a.id, title: a.title, section: sectionName.get(a.sectionId) ?? "", dueAt: a.dueAt, currentDays: exts.find((x) => x.assignmentId === a.id)?.days ?? 0 }));
    return { appeals, extensions, appealWindowDays: windowDays, maxExtensionDays: maxDays };
  }

  @Post()
  @RequirePermissions(PERMS.portalRequestSubmit)
  async submit(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(submitSchema, body);
    const personId = await this.me(auth);
    const { windowDays, maxAppeals } = await this.limits();
    const now = new Date();
    let sectionId: string;
    let data: { enrollmentId?: string; assignmentId?: string; days?: number };
    if (input.kind === "grade_appeal") {
      const e = await this.db.enrollment.findFirst({ where: { id: input.enrollmentId, studentPersonId: personId } });
      if (!e) throw new NotFoundException();
      const f = await this.db.finalGrade.findUnique({ where: { enrollmentId: e.id } });
      if (!f?.publishedAt) throw new ConflictException("The final grade has not been published");
      if (now.getTime() > f.publishedAt.getTime() + windowDays * DAY_MS) throw new ConflictException({ code: "APPEAL_WINDOW_CLOSED", message: `The appeal window (${windowDays} days after publication) has closed` });
      if ((await this.db.studentRequest.count({ where: { enrollmentId: e.id, kind: "grade_appeal", status: { not: "withdrawn" } } })) >= maxAppeals) throw new ConflictException({ code: "APPEAL_LIMIT", message: `At most ${maxAppeals} appeals per course` });
      sectionId = e.sectionId;
      data = { enrollmentId: e.id };
    } else {
      const a = await this.db.assignment.findFirst({ where: { id: input.assignmentId, published: true, section: { enrollments: { some: { studentPersonId: personId, status: "enrolled" } } } }, include: { section: true } });
      if (!a) throw new NotFoundException();
      if (a.section.status === "ended" || a.section.status === "cancelled") throw new ConflictException(`The section is ${a.section.status}`);
      if (a.manualOnly) throw new ConflictException("This assignment is not submitted online, so there is no deadline to extend");
      const ext = await this.db.assignmentExtension.findFirst({ where: { assignmentId: a.id, studentPersonId: personId } });
      if (now >= effectiveDeadline(a.dueAt, ext?.days)) throw new ConflictException({ code: "DEADLINE_PASSED", message: "The deadline has passed; ask your instructor directly" });
      await this.params.assertExtensionDays(input.days);
      if (ext && input.days <= ext.days) throw new ConflictException({ code: "ALREADY_EXTENDED", message: `You already have a ${ext.days}-day extension; request more days than that` });
      const sub = await this.db.submission.findFirst({ where: { assignmentId: a.id, studentPersonId: personId } });
      if (sub && sub.status !== "submitted") throw new ConflictException("Your submission is already being graded");
      sectionId = a.sectionId;
      data = { assignmentId: a.id, days: input.days };
    }
    try {
      const row = await this.db.studentRequest.create({ data: { tenantId: auth.tenantId, kind: input.kind, sectionId, studentPersonId: personId, reason: input.reason, ...data } });
      await this.outbox.emit("request.submitted", { requestId: row.id });
      await this.audit.record(auth.accountId, "request.submit", "section", sectionId, { requestId: row.id, kind: input.kind });
      return (await this.describe([row]))[0];
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") throw new ConflictException({ code: "ALREADY_PENDING", message: "You already have a pending request for this" });
      throw e;
    }
  }

  @Post(":id/withdraw")
  @RequirePermissions(PERMS.portalRequestSubmit)
  async withdraw(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const personId = await this.me(auth);
    const { count } = await this.db.studentRequest.updateMany({ where: { id, studentPersonId: personId, status: "pending" }, data: { status: "withdrawn", decidedAt: new Date() } });
    if (!count) {
      if (!(await this.db.studentRequest.findFirst({ where: { id, studentPersonId: personId } }))) throw new NotFoundException();
      throw new BadRequestException("Only pending requests can be withdrawn");
    }
    const row = await this.db.studentRequest.findUniqueOrThrow({ where: { id } });
    await this.audit.record(auth.accountId, "request.withdraw", "section", row.sectionId, { requestId: id });
    return (await this.describe([row]))[0];
  }

  private async describe(rows: Array<Awaited<ReturnType<typeof this.db.studentRequest.findMany>>[number]>) {
    const [sections, assignments] = await Promise.all([
      this.db.section.findMany({ where: { id: { in: rows.map((r) => r.sectionId) } }, select: { id: true, name: true } }),
      this.db.assignment.findMany({ where: { id: { in: rows.flatMap((r) => (r.assignmentId ? [r.assignmentId] : [])) } }, select: { id: true, title: true } }),
    ]);
    return rows.map((r) => ({
      id: r.id, kind: r.kind, status: r.status, section: sections.find((s) => s.id === r.sectionId)?.name ?? "", assignment: assignments.find((a) => a.id === r.assignmentId)?.title ?? null,
      days: r.days, reason: r.reason, decisionNote: r.decisionNote, decidedAt: r.decidedAt, result: r.result, createdAt: r.createdAt,
    }));
  }
}
