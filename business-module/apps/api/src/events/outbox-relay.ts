// 转发器：把出站箱里没处理的事件发到 Kafka，发成功（Kafka 确认）才标为已处理。
//   - Kafka 不可用：这一轮停下，事件原样留在表里（只记最后一次错误），恢复后继续发，不丢；
//   - 发出去但确认丢了：下一轮会再发一次，消费者靠事件 id 去重（通知按事件 id + 收件人唯一）；
//   - 载荷里有敏感字段：这个事件放弃（failed_at），不发出去；
//   - 多个实例同时跑：FOR UPDATE SKIP LOCKED 各拿各的。
import { Injectable, Logger } from "@nestjs/common";
import { PlatformPrismaService } from "../platform/platform-prisma.service";
import { toEnvelope, topicFor, unsafePayload } from "./envelope";
import { KafkaService } from "./kafka.service";

@Injectable()
export class OutboxRelay {
  private readonly log = new Logger(OutboxRelay.name);

  constructor(
    private readonly db: PlatformPrismaService,
    private readonly kafka: KafkaService,
  ) {}

  /** 一轮：返回发出去的条数。 */
  async tick(limit = 100): Promise<number> {
    return this.db.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text FROM biz.outbox_event WHERE processed_at IS NULL AND failed_at IS NULL ORDER BY created_at LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
        let sent = 0;
        for (const { id } of locked) {
          const row = await tx.outboxEvent.findUniqueOrThrow({ where: { id } });
          const problem = unsafePayload(row.payload);
          if (problem) {
            await tx.outboxEvent.update({ where: { id }, data: { failedAt: new Date(), lastError: `refused: ${problem}` } });
            continue;
          }
          try {
            await this.kafka.publishEvent(topicFor(row.type), toEnvelope(row));
            await tx.outboxEvent.update({ where: { id }, data: { processedAt: new Date(), lastError: null } });
            sent++;
          } catch (err) {
            const reason = String(err instanceof Error ? err.message : err).slice(0, 500);
            await tx.outboxEvent.update({ where: { id }, data: { lastError: reason } });
            this.log.warn(`Kafka is not accepting events (${reason}); ${locked.length - sent} events stay in the outbox`);
            break; // 后面的发也会失败：这一轮到此为止，保持顺序
          }
        }
        return sent;
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
  }
}
