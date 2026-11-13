// 出站箱事件 → 要通知谁、用哪个模板。没有登记的事件类型视为"不需要通知"，直接标为已处理。
// 加一种通知 = 在 TEMPLATES 里加模板、在这里加一个处理函数。
import type { PlatformPrismaService } from "../platform/platform-prisma.service";
import type { Recipient } from "./notification.service";

export interface OutboxRow {
  id: string;
  tenantId: string;
  type: string;
  payload: unknown;
}
export interface HandlerResult {
  /** 收件人（人员 id），投递时换成账号 */
  items: Array<{ personId: string; type: string; params: Record<string, unknown> }>;
}
export type EventHandler = (db: PlatformPrismaService, evt: OutboxRow) => Promise<HandlerResult>;

type P = Record<string, string | undefined>;
const sectionName = async (db: PlatformPrismaService, id?: string) => (id ? ((await db.section.findUnique({ where: { id }, select: { name: true } }))?.name ?? "") : "");

export const EVENT_HANDLERS: Record<string, EventHandler> = {
  async "enrollment.registrar_added"(db, evt) {
    const p = evt.payload as P;
    return { items: p.studentPersonId ? [{ personId: p.studentPersonId, type: evt.type, params: { section: await sectionName(db, p.sectionId) } }] : [] };
  },
  async "enrollment.registrar_removed"(db, evt) {
    const p = evt.payload as P;
    return { items: p.studentPersonId ? [{ personId: p.studentPersonId, type: evt.type, params: { section: await sectionName(db, p.sectionId), status: p.status ?? "" } }] : [] };
  },
  async "section.cancelled"(db, evt) {
    const p = evt.payload as P;
    return { items: p.studentPersonId ? [{ personId: p.studentPersonId, type: evt.type, params: { section: await sectionName(db, p.sectionId) } }] : [] };
  },
  async "assignment.published"(db, evt) {
    const p = evt.payload as P;
    const a = p.assignmentId ? await db.assignment.findUnique({ where: { id: p.assignmentId } }) : null;
    if (!a) return { items: [] };
    const students = await db.enrollment.findMany({ where: { sectionId: a.sectionId, status: "enrolled" }, select: { studentPersonId: true } });
    const params = { title: a.title, section: await sectionName(db, a.sectionId), dueDate: a.dueDate.toISOString().slice(0, 10) };
    return { items: students.map((s) => ({ personId: s.studentPersonId, type: evt.type, params })) };
  },
  async "submission.published"(db, evt) {
    const p = evt.payload as P;
    const a = p.assignmentId ? await db.assignment.findUnique({ where: { id: p.assignmentId } }) : null;
    return { items: a && p.studentPersonId ? [{ personId: p.studentPersonId, type: evt.type, params: { title: a.title, section: await sectionName(db, a.sectionId) } }] : [] };
  },
  async "final_grade.published"(db, evt) {
    const p = evt.payload as P;
    const e = p.enrollmentId ? await db.enrollment.findUnique({ where: { id: p.enrollmentId } }) : null;
    return { items: e ? [{ personId: e.studentPersonId, type: evt.type, params: { section: await sectionName(db, e.sectionId) } }] : [] };
  },
};

export type { Recipient };
