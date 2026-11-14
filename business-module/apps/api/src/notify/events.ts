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
// 事件里的 id 一律带上事件自己的租户一起查：伪造的事件（租户 A 的信封里放租户 B 的 id）查不到 B 的任何东西
const sectionName = async (db: PlatformPrismaService, tenantId: string, id?: string) => (id ? ((await db.section.findFirst({ where: { id, tenantId }, select: { name: true } }))?.name ?? "") : "");

export const EVENT_HANDLERS: Record<string, EventHandler> = {
  async "enrollment.registrar_added"(db, evt) {
    const p = evt.payload as P;
    return { items: p.studentPersonId ? [{ personId: p.studentPersonId, type: evt.type, params: { section: await sectionName(db, evt.tenantId, p.sectionId) } }] : [] };
  },
  async "enrollment.registrar_removed"(db, evt) {
    const p = evt.payload as P;
    return { items: p.studentPersonId ? [{ personId: p.studentPersonId, type: evt.type, params: { section: await sectionName(db, evt.tenantId, p.sectionId), status: p.status ?? "" } }] : [] };
  },
  async "section.cancelled"(db, evt) {
    const p = evt.payload as P;
    return { items: p.studentPersonId ? [{ personId: p.studentPersonId, type: evt.type, params: { section: await sectionName(db, evt.tenantId, p.sectionId) } }] : [] };
  },
  async "assignment.published"(db, evt) {
    const p = evt.payload as P;
    const a = p.assignmentId ? await db.assignment.findFirst({ where: { id: p.assignmentId, tenantId: evt.tenantId } }) : null;
    if (!a) return { items: [] };
    const students = await db.enrollment.findMany({ where: { sectionId: a.sectionId, tenantId: evt.tenantId, status: "enrolled" }, select: { studentPersonId: true } });
    const params = { title: a.title, section: await sectionName(db, evt.tenantId, a.sectionId), dueDate: a.dueDate.toISOString().slice(0, 10) };
    return { items: students.map((s) => ({ personId: s.studentPersonId, type: evt.type, params })) };
  },
  async "submission.published"(db, evt) {
    const p = evt.payload as P;
    const a = p.assignmentId ? await db.assignment.findFirst({ where: { id: p.assignmentId, tenantId: evt.tenantId } }) : null;
    return { items: a && p.studentPersonId ? [{ personId: p.studentPersonId, type: evt.type, params: { title: a.title, section: await sectionName(db, evt.tenantId, a.sectionId) } }] : [] };
  },
  async "final_grade.published"(db, evt) {
    const p = evt.payload as P;
    const e = p.enrollmentId ? await db.enrollment.findFirst({ where: { id: p.enrollmentId, tenantId: evt.tenantId } }) : null;
    return { items: e ? [{ personId: e.studentPersonId, type: evt.type, params: { section: await sectionName(db, evt.tenantId, e.sectionId) } }] : [] };
  },
};

/** 讨论通知：发帖通知任课教师；回复通知发帖人和任课教师；标记已解决通知发帖人（都不通知自己）。 */
async function discussionRecipients(db: PlatformPrismaService, evt: OutboxRow, kind: "posted" | "replied" | "resolved"): Promise<HandlerResult> {
  const p = evt.payload as P;
  const thread = p.postId ? await db.discussionPost.findFirst({ where: { id: p.postId, tenantId: evt.tenantId } }) : null;
  if (!thread) return { items: [] };
  const [section, teachers] = await Promise.all([sectionName(db, evt.tenantId, thread.sectionId), db.sectionInstructor.findMany({ where: { sectionId: thread.sectionId, tenantId: evt.tenantId }, select: { personId: true } })]);
  const actor = kind === "resolved" ? p.resolverPersonId : p.authorPersonId;
  const author = actor ? ((await db.person.findFirst({ where: { id: actor, tenantId: evt.tenantId }, select: { fullName: true } }))?.fullName ?? "") : "";
  const to = kind === "posted" ? teachers.map((t) => t.personId) : kind === "replied" ? [thread.authorPersonId, ...teachers.map((t) => t.personId)] : [thread.authorPersonId];
  const params = { section, title: thread.title ?? "", author };
  return { items: [...new Set(to)].filter((id) => id !== actor).map((personId) => ({ personId, type: evt.type, params })) };
}
EVENT_HANDLERS["discussion.posted"] = (db, evt) => discussionRecipients(db, evt, "posted");
EVENT_HANDLERS["discussion.replied"] = (db, evt) => discussionRecipients(db, evt, "replied");
EVENT_HANDLERS["discussion.resolved"] = (db, evt) => discussionRecipients(db, evt, "resolved");

export type { Recipient };
