// 作业与提交共用：输入校验、有效截止时间（含延期）、迟交重算。
import { z } from "zod";
import { Prisma } from "../generated/prisma";
import { latePolicySchema, hoursLate, penaltyPct, type LatePolicy } from "./late-penalty";

export const DAY_MS = 86_400_000;

export const dayInput = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "must be YYYY-MM-DD");
export const pointsInput = z.number().min(0).max(1000).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, { message: "at most 2 decimals" });

export const rubricSchema = z
  .array(z.object({ title: z.string().trim().min(1).max(200), description: z.string().trim().max(1000).nullable().optional(), maxPoints: pointsInput.refine((n) => n > 0, { message: "must be above 0" }) }))
  .max(30);

export const attachmentsSchema = z.array(z.object({ title: z.string().trim().min(1).max(200), url: z.string().url().max(1000) })).max(10);

export const createAssignmentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20000).optional(),
  dueDate: dayInput,
  groupId: z.string().uuid().nullable().optional(),
  allowLate: z.boolean().optional(),
  latePolicy: latePolicySchema.optional(),
  attachments: attachmentsSchema.optional(),
  rubric: rubricSchema.optional(),
});

export const patchAssignmentSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(20000),
    dueDate: dayInput,
    groupId: z.string().uuid().nullable(),
    allowLate: z.boolean(),
    latePolicy: latePolicySchema,
    attachments: attachmentsSchema,
  })
  .partial()
  .strict();

export interface DeadlineInfo {
  dueAt: Date;
  latePolicy: unknown;
}

/** 某个学生的有效截止时间：原截止时间 + 延期天数。 */
export const effectiveDeadline = (dueAt: Date, extensionDays: number | null | undefined): Date => new Date(dueAt.getTime() + (extensionDays ?? 0) * DAY_MS);

/** 提交时刻对应的迟交情况。 */
export function lateness(assignment: DeadlineInfo, extensionDays: number | null | undefined, at: Date): { isLate: boolean; hours: number; pct: number } {
  const hours = hoursLate(effectiveDeadline(assignment.dueAt, extensionDays), at);
  return { isLate: hours > 0, hours, pct: penaltyPct(assignment.latePolicy as LatePolicy, hours) };
}

/** 截止时间、迟交表或延期变了以后，重算还没开始批改的提交的迟交情况（已批改的不动：调用方要先拦住）。 */
export async function recomputeLateness(tx: Prisma.TransactionClient, assignment: { id: string; dueAt: Date; latePolicy: unknown }): Promise<void> {
  const [subs, extensions] = await Promise.all([tx.submission.findMany({ where: { assignmentId: assignment.id, status: "submitted" } }), tx.assignmentExtension.findMany({ where: { assignmentId: assignment.id } })]);
  const days = new Map(extensions.map((e) => [e.studentPersonId, e.days]));
  for (const s of subs) {
    const l = lateness(assignment, days.get(s.studentPersonId), s.submittedAt);
    await tx.submission.update({ where: { id: s.id }, data: { isLate: l.isLate, hoursLate: new Prisma.Decimal(l.hours.toFixed(2)), latePenaltyPct: l.pct } });
  }
}

export const num = (d: Prisma.Decimal | null | undefined): number | null => (d == null ? null : Number(d));
