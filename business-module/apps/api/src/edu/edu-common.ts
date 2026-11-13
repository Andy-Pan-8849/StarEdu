// 教学模块共用：上课安排的校验与冲突检测、班级的数据范围映射。
import { z } from "zod";
import type { ScopeMapping } from "../data-scope/scope-filter";

export const scheduleItem = z
  .object({
    weekday: z.number().int().min(1).max(7),
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    room: z.string().max(100).optional(),
  })
  .refine((s) => s.start < s.end, { message: "start must be before end" });
export const scheduleSchema = z.array(scheduleItem).max(20);
export type ScheduleItem = z.infer<typeof scheduleItem>;

/** 两个班的上课安排是否有重叠（同一个星期、时间段相交）。时间是各自校区的当地时间，调用方负责只在同一时区里比较。 */
export function schedulesOverlap(a: ScheduleItem[], b: ScheduleItem[]): boolean {
  return a.some((x) => b.some((y) => x.weekday === y.weekday && x.start < y.end && y.start < x.end));
}

/** 班级的数据范围：按校区所在部门（"本部门及以下"）、本人任教或就读、"本人任教/就读的班级"。 */
export const SECTION_SCOPE: ScopeMapping = {
  dept: (ids) => ({ campus: { deptId: { in: ids } } }),
  self: (personId) => ({
    OR: [{ instructors: { some: { personId } } }, { enrollments: { some: { studentPersonId: personId, status: { in: ["enrolled", "completed"] } } } }],
  }),
  classes: (ids) => ({ id: { in: ids } }),
};

export const dayString = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
