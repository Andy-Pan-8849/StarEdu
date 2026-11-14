// 后台工作：把出站箱的事件变成通知；把排队的邮件发出去。
//   - 多个实例可以同时跑：用 FOR UPDATE SKIP LOCKED 抢活，各拿各的，不重复处理、不互相等待。
//   - 事件处理失败：记次数和原因，最多试 5 次，之后标为"放弃"留着排查（不会无限重试）。
//   - 邮件：通知行上的 email_status 就是队列；发送失败最多试 5 次。
//   - 幂等：通知按（账号，事件 id）唯一，事件被重复处理也不会重复生成。
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { MailService } from "../mail/mail.service";
import { PlatformPrismaService } from "../platform/platform-prisma.service";
import { busMode } from "../events/event-bus";
import { OutboxRelay } from "../events/outbox-relay";
import { EVENT_HANDLERS } from "./events";
import { NotificationService, signUnsubscribe } from "./notification.service";
import { EMAIL_FOOTER, pickLocale, render } from "./templates";

const MAX_ATTEMPTS = 5;

@Injectable()
export class NotifyWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(NotifyWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: PlatformPrismaService,
    private readonly notify: NotificationService,
    private readonly mail: MailService,
    private readonly relay: OutboxRelay,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NOTIFY_WORKER === "off") return;
    const every = Number(process.env.NOTIFY_POLL_MS) > 0 ? Number(process.env.NOTIFY_POLL_MS) : 2000;
    this.timer = setInterval(() => void this.tick(), every);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 一轮：出站箱模式下直接处理事件；kafka 模式下把事件转发到 Kafka（处理由消费组做）。然后发邮件。同一实例里不重叠。 */
  async tick(): Promise<{ events: number; emails: number }> {
    if (this.running) return { events: 0, emails: 0 };
    this.running = true;
    try {
      const events = busMode() === "kafka" ? await this.relay.tick() : await this.processOutbox();
      return { events, emails: await this.sendEmails() };
    } catch (err) {
      this.log.warn(`worker tick failed: ${err instanceof Error ? err.message : err}`);
      return { events: 0, emails: 0 };
    } finally {
      this.running = false;
    }
  }

  /** 一个事件 → 通知。出站箱模式和 Kafka 消费者共用；按（账号，事件 id）去重，重复处理没有副作用。 */
  async handleEvent(evt: { id: string; tenantId: string; type: string; payload: unknown }): Promise<void> {
    const handler = EVENT_HANDLERS[evt.type];
    if (!handler) return;
    const { items } = await handler(this.db, evt);
    const accounts = await this.notify.accountsOfPersons(evt.tenantId, [...new Set(items.map((i) => i.personId))]);
    const recipients = items.flatMap((i) => (accounts.has(i.personId) ? [{ accountId: accounts.get(i.personId) as string, type: i.type, params: i.params }] : []));
    await this.notify.deliver(evt.tenantId, null, recipients, evt.id);
  }

  async processOutbox(limit = 50): Promise<number> {
    return this.db.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text FROM biz.outbox_event WHERE processed_at IS NULL AND failed_at IS NULL ORDER BY created_at LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
        for (const { id } of locked) {
          const evt = await tx.outboxEvent.findUniqueOrThrow({ where: { id } });
          try {
            await this.handleEvent(evt);
            await tx.outboxEvent.update({ where: { id }, data: { processedAt: new Date() } });
          } catch (err) {
            const attempts = evt.attempts + 1;
            await tx.outboxEvent.update({ where: { id }, data: { attempts, lastError: String(err instanceof Error ? err.message : err).slice(0, 500), failedAt: attempts >= MAX_ATTEMPTS ? new Date() : null } });
          }
        }
        return locked.length;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  }

  async sendEmails(limit = 20): Promise<number> {
    return this.db.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text FROM biz.notification WHERE email_status = 'pending' ORDER BY created_at LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
        let sent = 0;
        for (const { id } of locked) {
          const n = await tx.notification.findUniqueOrThrow({ where: { id } });
          try {
            const [account, tenant] = await Promise.all([tx.account.findUnique({ where: { id: n.accountId } }), tx.tenant.findUnique({ where: { id: n.tenantId } })]);
            if (!account?.email || !tenant) {
              await tx.notification.update({ where: { id }, data: { emailStatus: "none" } });
              continue;
            }
            const locale = pickLocale(account.locale);
            const text = n.type === "announcement" ? { title: n.title ?? "", body: n.body ?? "" } : render(n.type, n.params as Record<string, unknown>, locale);
            const url = `${(process.env.PUBLIC_API_URL ?? "http://{code}.localhost:4000").replace("{code}", tenant.code)}/api/unsubscribe?token=${signUnsubscribe(n.tenantId, n.accountId, n.category)}`;
            await this.mail.send(account.email, text.title, `${text.body}\n\n${EMAIL_FOOTER[locale](n.category, url)}`, { "List-Unsubscribe": `<${url}>` });
            await tx.notification.update({ where: { id }, data: { emailStatus: "sent", emailAttempts: n.emailAttempts + 1 } });
            sent++;
          } catch {
            const attempts = n.emailAttempts + 1;
            await tx.notification.update({ where: { id }, data: { emailAttempts: attempts, emailStatus: attempts >= MAX_ATTEMPTS ? "failed" : "pending" } });
          }
        }
        return sent;
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
  }
}
