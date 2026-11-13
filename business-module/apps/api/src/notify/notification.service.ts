// 通知的核心：生成站内消息（同时为邮件排队）、偏好、退订链接、截止提醒。
// 后台任务跨租户工作，所以这里用库所有者连接（绕过行级安全），每次写入都显式带 tenant_id；
// 面向用户的读写（消息中心、偏好）在各自的控制器里走租户感知的连接。
import { Injectable } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { PlatformPrismaService } from "../platform/platform-prisma.service";
import { RedisService } from "../redis/redis.service";
import { categoryOf, CATEGORIES, type Category } from "./templates";

export interface Recipient {
  accountId: string;
  type: string;
  params?: Record<string, unknown>;
  /** 公告等自由文字 */
  title?: string;
  body?: string;
}

const secret = () => process.env.NOTIFY_SECRET ?? "dev-only-notify-secret";

export function signUnsubscribe(tenantId: string, accountId: string, category: string): string {
  const payload = Buffer.from(JSON.stringify({ t: tenantId, a: accountId, c: category })).toString("base64url");
  const sig = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function readUnsubscribe(token: string): { tenantId: string; accountId: string; category: Category } | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", secret()).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const v = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { t: string; a: string; c: string };
    return (CATEGORIES as readonly string[]).includes(v.c) ? { tenantId: v.t, accountId: v.a, category: v.c as Category } : null;
  } catch {
    return null;
  }
}

@Injectable()
export class NotificationService {
  constructor(
    private readonly db: PlatformPrismaService,
    private readonly redis: RedisService,
  ) {}

  /** 事件里的人员 id → 能登录的账号 id。 */
  async accountsOfPersons(tenantId: string, personIds: string[]): Promise<Map<string, string>> {
    const rows = await this.db.account.findMany({ where: { tenantId, personId: { in: personIds }, status: "active", deletedAt: null, isService: false }, select: { id: true, personId: true } });
    return new Map(rows.map((r) => [r.personId as string, r.id]));
  }

  /**
   * 给一批收件人生成消息。dedupeKey（事件 id、公告 id 等）和账号合起来唯一：同一事件重复投递，每人仍然只有一条。
   * 按收件人的偏好：站内关了就不进消息中心；邮件关了或没有邮箱就不排队；两样都关了就什么都不写。返回新生成的条数。
   */
  async deliver(tenantId: string, category: Category | null, recipients: Recipient[], dedupeKey: string): Promise<number> {
    if (!recipients.length) return 0;
    const ids = [...new Set(recipients.map((r) => r.accountId))];
    const [accounts, prefs] = await Promise.all([
      this.db.account.findMany({ where: { tenantId, id: { in: ids }, status: "active", deletedAt: null }, select: { id: true, email: true } }),
      this.db.notificationPreference.findMany({ where: { tenantId, accountId: { in: ids } } }),
    ]);
    const account = new Map(accounts.map((a) => [a.id, a]));
    let created = 0;
    for (const r of recipients) {
      const a = account.get(r.accountId);
      if (!a) continue;
      const cat = category ?? categoryOf(r.type);
      const pref = prefs.find((p) => p.accountId === r.accountId && p.category === cat);
      const inApp = pref?.inApp ?? true;
      const email = (pref?.email ?? true) && !!a.email;
      if (!inApp && !email) continue;
      try {
        const n = await this.db.notification.create({
          data: { tenantId, accountId: r.accountId, category: cat, type: r.type, params: (r.params ?? {}) as never, title: r.title ?? null, body: r.body ?? null, inApp, dedupeKey, emailStatus: email ? "pending" : "none" },
        });
        created++;
        if (inApp) await this.push(tenantId, r.accountId, n.id);
      } catch (err) {
        if ((err as { code?: string }).code !== "P2002") throw err; // 已经有了：重复投递，正常
      }
    }
    return created;
  }

  /** 通知所有实例：持有这个账号 WebSocket 连接的那个实例会把它推给用户。 */
  private async push(tenantId: string, accountId: string, id: string): Promise<void> {
    try {
      await this.redis.client.publish("notify", JSON.stringify({ tenantId, accountId, id }));
    } catch {
      // 推送失败不影响消息本身：用户下次打开或重连时会补拉
    }
  }

  /** 截止提醒：截止前 24 小时内、还没提交的学生各收一条；每个作业每个学生只提醒一次（含延期后的个人截止时间）。 */
  async deadlineReminders(now = new Date()): Promise<{ reminded: number }> {
    const assignments = await this.db.assignment.findMany({
      where: { published: true, manualOnly: false, dueAt: { gte: new Date(now.getTime() - 3 * 864e5), lte: new Date(now.getTime() + 25 * 36e5) }, section: { status: { in: ["open", "in_progress"] } } },
      include: { section: true },
    });
    let reminded = 0;
    for (const a of assignments) {
      const [enrollments, subs, exts] = await Promise.all([
        this.db.enrollment.findMany({ where: { sectionId: a.sectionId, status: "enrolled" } }),
        this.db.submission.findMany({ where: { assignmentId: a.id }, select: { studentPersonId: true } }),
        this.db.assignmentExtension.findMany({ where: { assignmentId: a.id } }),
      ]);
      const done = new Set(subs.map((s) => s.studentPersonId));
      const days = new Map(exts.map((e) => [e.studentPersonId, e.days]));
      const due = enrollments.filter((e) => {
        if (done.has(e.studentPersonId)) return false;
        const deadline = a.dueAt.getTime() + (days.get(e.studentPersonId) ?? 0) * 864e5;
        return now.getTime() >= deadline - 24 * 36e5 && now.getTime() < deadline;
      });
      const accounts = await this.accountsOfPersons(a.tenantId, due.map((e) => e.studentPersonId));
      for (const e of due) {
        const accountId = accounts.get(e.studentPersonId);
        if (!accountId) continue;
        const deadline = new Date(a.dueAt.getTime() + (days.get(e.studentPersonId) ?? 0) * 864e5).toISOString().slice(0, 16).replace("T", " ") + " UTC";
        reminded += await this.deliver(a.tenantId, "reminder", [{ accountId, type: "reminder.deadline", params: { title: a.title, section: a.section.name, deadline } }], `reminder:${a.id}:${e.studentPersonId}:24h`);
      }
    }
    return { reminded };
  }
}
