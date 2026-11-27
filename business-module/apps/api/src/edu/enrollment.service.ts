// 选课与退课的核心逻辑：学生自助和教务代选调用同一个服务，区别只是校验规则的宽严和留痕。
//
//   硬性阻止（谁都不行）：班级不是开放状态（教务可在"进行中"特批）、学期已结束、学籍不是"在读"、
//     同一门课已经在读（重复）、同一个人在这个班里是老师。
//   学生自助：容量已满、先修课没通过、不在选课窗口内、这门课已经通过过 —— 阻止；时间冲突只提示不阻止。
//   教务代选：以上这几项（含时间冲突）都是"可确认"的情形：必须带上确认清单和原因，才会通过，并留痕。
//   并发：事务内先锁住班级这一行（SELECT … FOR UPDATE），再数人数，所以多个请求抢最后一个名额只会成功一个。
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "../generated/prisma";
import { AuditService } from "../audit/audit.service";
import { todayUtc } from "../hr/effective";
import { requireTenant } from "../tenancy/request-scope";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { schedulesOverlap, type ScheduleItem } from "./edu-common";
import { extendedEvents } from "../events/event-bus";
import { OutboxService } from "./outbox.service";

export type Violation = "capacity" | "prerequisite" | "window" | "retake" | "conflict";

export interface EnrollInput {
  sectionId: string;
  studentPersonId: string;
  method: "self" | "registrar";
  actorAccountId: string | null;
  /** 教务代选：确认过的情形 */
  confirm?: string[];
  reason?: string;
  /** 只检查、不写入（批量选课的预览用）：规则和正式选课完全一样，到最后一步不创建 */
  dryRun?: boolean;
}

export interface EnrollResult {
  enrollmentId: string;
  /** 自助选课时的时间冲突提示（只提示不阻止） */
  conflicts: Array<{ sectionId: string; name: string }>;
  conflictCheckSkipped: boolean;
}

/** 学生自己退课的最后一天：学期的退课截止日；没设就是开学后 14 天。 */
export const DEFAULT_DROP_DAYS = 14;
export function studentDropDeadline(term: { dropDeadline: Date | null; startDate: Date }): Date {
  return term.dropDeadline ?? new Date(term.startDate.getTime() + DEFAULT_DROP_DAYS * 86_400_000);
}

@Injectable()
export class EnrollmentService {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  private async lockSection(tx: Prisma.TransactionClient, sectionId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM biz.section WHERE id = ${sectionId}::uuid FOR UPDATE`;
  }

  async enroll(input: EnrollInput): Promise<EnrollResult> {
    const tenant = requireTenant("enroll");
    return this.tenantDb.transaction(async (tx) => {
      await this.lockSection(tx, input.sectionId);
      const section = await tx.section.findUnique({ where: { id: input.sectionId }, include: { course: true, term: true, campus: true } });
      if (!section) throw new NotFoundException("Unknown section");
      const registrar = input.method === "registrar";

      // ---- 硬性阻止 ----
      if (section.status === "draft" || section.status === "cancelled" || section.status === "ended") throw this.block("SECTION_NOT_OPEN", `The section is ${section.status}`);
      if (section.status === "in_progress" && !registrar) throw this.block("SECTION_NOT_OPEN", "The section is no longer open for enrollment");
      if (section.term.status === "ended") throw this.block("TERM_ENDED", "The term has ended");
      const profile = await tx.studentProfile.findFirst({ where: { personId: input.studentPersonId } });
      if (!profile) throw this.block("NOT_A_STUDENT", "The person has no student profile");
      if (profile.academicStatus !== "enrolled") throw this.block("NOT_ENROLLED", `The student's status is ${profile.academicStatus}; only enrolled students can take courses`);
      const duplicate = await tx.enrollment.findFirst({ where: { studentPersonId: input.studentPersonId, status: "enrolled", section: { courseId: section.courseId } } });
      if (duplicate) throw this.block("DUPLICATE", "The student is already taking this course");
      if (await tx.sectionInstructor.findFirst({ where: { sectionId: section.id, personId: input.studentPersonId } })) throw this.block("INSTRUCTOR", "A person cannot be both instructor and student in the same section");

      // ---- 可确认的情形 ----
      const violations: Violation[] = [];
      const detail: Record<string, unknown> = {};
      const seated = await tx.enrollment.count({ where: { sectionId: section.id, status: "enrolled" } });
      if (seated >= section.capacity) {
        violations.push("capacity");
        detail.capacity = { seated, capacity: section.capacity };
      }
      const prereqs = await tx.coursePrerequisite.findMany({ where: { courseId: section.courseId }, include: { prerequisite: true } });
      const missing: string[] = [];
      for (const p of prereqs) {
        const passed = await tx.enrollment.findFirst({ where: { studentPersonId: input.studentPersonId, passed: true, section: { courseId: p.prerequisiteId } } });
        if (!passed) missing.push(p.prerequisite.code);
      }
      if (missing.length) {
        violations.push("prerequisite");
        detail.prerequisite = missing;
      }
      const today = todayUtc();
      const t = section.term;
      if (section.status === "in_progress" || (t.enrollOpenDate && today < t.enrollOpenDate) || (t.enrollCloseDate && today > t.enrollCloseDate)) violations.push("window");
      if (await tx.enrollment.findFirst({ where: { studentPersonId: input.studentPersonId, passed: true, section: { courseId: section.courseId } } })) violations.push("retake");

      // 时间冲突：同一学期已选的班里有重叠的上课安排；校区时区不同的不比较（墙上时间没有可比性）
      const mine = await tx.enrollment.findMany({ where: { studentPersonId: input.studentPersonId, status: "enrolled", section: { termId: section.termId } }, include: { section: { include: { campus: true } } } });
      const conflicts: Array<{ sectionId: string; name: string }> = [];
      let skipped = false;
      for (const e of mine) {
        if (e.section.campus.timezone !== section.campus.timezone) {
          skipped = true;
          continue;
        }
        if (schedulesOverlap(section.schedule as unknown as ScheduleItem[], e.section.schedule as unknown as ScheduleItem[])) conflicts.push({ sectionId: e.sectionId, name: e.section.name });
      }
      if (conflicts.length) {
        violations.push("conflict");
        detail.conflict = conflicts;
      }

      let overrides: Violation[] = [];
      if (registrar) {
        if (violations.length > 0) {
          const confirmed = new Set(input.confirm ?? []);
          if (!violations.every((v) => confirmed.has(v)) || !input.reason?.trim()) {
            throw new ConflictException({ code: "CONFIRMATION_REQUIRED", message: "These situations need to be confirmed with a reason", violations, detail, needReason: true });
          }
          overrides = violations;
        }
      } else {
        const blocking = violations.filter((v) => v !== "conflict");
        if (blocking.length) throw new ConflictException({ code: "RULE_VIOLATION", message: "The enrollment rules are not met", violations: blocking, detail });
      }

      if (input.dryRun) return { enrollmentId: "", conflicts: registrar ? [] : conflicts, conflictCheckSkipped: skipped };
      const created = await tx.enrollment.create({
        data: { tenantId: tenant.tenantId, sectionId: section.id, studentPersonId: input.studentPersonId, method: input.method, reason: registrar ? (input.reason ?? null) : null, overrides: overrides as never, createdBy: input.actorAccountId },
      });
      if (extendedEvents()) await tx.outboxEvent.create({ data: { tenantId: tenant.tenantId, type: "enrollment.enrolled", payload: { enrollmentId: created.id, studentPersonId: input.studentPersonId, sectionId: section.id, method: input.method } } });
      if (registrar) await tx.outboxEvent.create({ data: { tenantId: tenant.tenantId, type: "enrollment.registrar_added", payload: { enrollmentId: created.id, studentPersonId: input.studentPersonId, sectionId: section.id, overrides } } });
      return { enrollmentId: created.id, conflicts: registrar ? [] : conflicts, conflictCheckSkipped: skipped };
    }).then(async (result) => {
      if (input.method === "registrar" && !input.dryRun) await this.audit.record(input.actorAccountId, "enrollment.add", "section", input.sectionId, { studentPersonId: input.studentPersonId, overrides: input.confirm ?? [], reason: input.reason ?? null });
      return result;
    });
  }

  /** 退课：退课截止日（含）之前作废；之后学生不能再退（只能上完拿成绩），教务老师仍可代办，记 W（退课）。没设截止日的学期，学生在开学后 14 天内可退。学期或班级结束后谁都不能退。 */
  async drop(opts: { enrollmentId: string; actorAccountId: string | null; actorPersonId?: string | null; byRegistrar: boolean }) {
    const tenant = requireTenant("drop");
    const result = await this.tenantDb.transaction(async (tx) => {
      const found = await tx.enrollment.findUnique({ where: { id: opts.enrollmentId } });
      if (!found) throw new NotFoundException();
      await this.lockSection(tx, found.sectionId);
      const e = await tx.enrollment.findUnique({ where: { id: opts.enrollmentId }, include: { section: { include: { term: true } } } });
      if (!e) throw new NotFoundException();
      if (!opts.byRegistrar && e.studentPersonId !== opts.actorPersonId) throw new NotFoundException(); // 不是自己的选课：404
      if (e.status !== "enrolled") throw new ConflictException(`The enrollment is already ${e.status}`);
      if (e.section.term.status === "ended" || e.section.status === "ended") throw new ConflictException("The term or section has ended; the record is final");
      const deadline = e.section.term.dropDeadline;
      if (!opts.byRegistrar && todayUtc() > studentDropDeadline(e.section.term)) throw new ConflictException("The drop deadline has passed; the course can no longer be dropped");
      const status = !deadline || todayUtc() <= deadline ? "voided" : "withdrawn";
      await tx.enrollment.update({ where: { id: e.id }, data: { status, droppedAt: new Date() } });
      if (extendedEvents()) await tx.outboxEvent.create({ data: { tenantId: tenant.tenantId, type: "enrollment.dropped", payload: { enrollmentId: e.id, studentPersonId: e.studentPersonId, sectionId: e.sectionId, status, by: opts.byRegistrar ? "registrar" : "student" } } });
      if (opts.byRegistrar) await tx.outboxEvent.create({ data: { tenantId: tenant.tenantId, type: "enrollment.registrar_removed", payload: { enrollmentId: e.id, studentPersonId: e.studentPersonId, sectionId: e.sectionId, status } } });
      return { id: e.id, status, sectionId: e.sectionId };
    });
    if (opts.byRegistrar) await this.audit.record(opts.actorAccountId, "enrollment.remove", "section", result.sectionId, { enrollmentId: result.id, status: result.status });
    return result;
  }

  /** 取消班级：已选的记录作废，并给每个学生写一条通知事件。 */
  async cancelSection(sectionId: string, actorAccountId: string | null): Promise<number> {
    const tenant = requireTenant("cancel section");
    return this.tenantDb.transaction(async (tx) => {
      await this.lockSection(tx, sectionId);
      const s = await tx.section.findUnique({ where: { id: sectionId } });
      if (!s) throw new NotFoundException();
      if (s.status === "ended" || s.status === "cancelled") throw new ConflictException(`The section is ${s.status}`);
      const active = await tx.enrollment.findMany({ where: { sectionId, status: "enrolled" } });
      await tx.enrollment.updateMany({ where: { sectionId, status: "enrolled" }, data: { status: "voided", droppedAt: new Date() } });
      await tx.section.update({ where: { id: sectionId }, data: { status: "cancelled", updatedBy: actorAccountId } });
      for (const e of active) await tx.outboxEvent.create({ data: { tenantId: tenant.tenantId, type: "section.cancelled", payload: { sectionId, studentPersonId: e.studentPersonId, enrollmentId: e.id } } });
      return active.length;
    });
  }

  /** 结课（或学期结束）：已选的记录转为"已完成"，最终成绩和是否通过由成绩模块（B8）写入。 */
  async completeSection(tx: Prisma.TransactionClient, sectionId: string): Promise<void> {
    await tx.enrollment.updateMany({ where: { sectionId, status: "enrolled" }, data: { status: "completed" } });
  }

  private block(code: string, message: string): ConflictException {
    return new ConflictException({ code, message });
  }

  /** 只给范围检查用：教务代选前，操作者要能管这个班。 */
  assertSectionManageable(allowed: boolean): void {
    if (!allowed) throw new ForbiddenException("This section is outside your data scope");
  }

  assertNotBlank(v: string | undefined, what: string): string {
    if (!v?.trim()) throw new BadRequestException(`${what} is required`);
    return v.trim();
  }
}
