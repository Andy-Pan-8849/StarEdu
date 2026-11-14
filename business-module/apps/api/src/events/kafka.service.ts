// Kafka 客户端：生产者（幂等、等全部副本确认）、消费者（失败重试，最终进死信主题）、主题创建。
// 只有 BIZ_EVENT_BUS=kafka 时才会真正连接；其他时候这个类只是个空壳，不碰网络。
import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { KafkaJS } from "@confluentinc/kafka-javascript";
import { kafkaConfig } from "./event-bus";
import type { EventEnvelope } from "./envelope";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms))]);

export interface ConsumerOptions {
  groupId: string;
  topic: string;
  dlqTopic: string;
  handle: (event: EventEnvelope) => Promise<void>;
  /** 处理失败后最多试几次（含第一次），之后进死信主题 */
  attempts?: number;
}

@Injectable()
export class KafkaService implements OnModuleDestroy {
  private readonly log = new Logger(KafkaService.name);
  private kafka: KafkaJS.Kafka | null = null;
  private producer: KafkaJS.Producer | null = null;
  private producerReady: Promise<KafkaJS.Producer> | null = null;
  private readonly consumers: KafkaJS.Consumer[] = [];
  private topicsReady: Promise<void> | null = null;

  private get client(): KafkaJS.Kafka {
    const cfg = kafkaConfig();
    return (this.kafka ??= new KafkaJS.Kafka({ kafkaJS: { brokers: cfg.brokers, clientId: cfg.clientId, logLevel: KafkaJS.logLevel.ERROR } }));
  }

  /** 建主题（已有就跳过）：业务事件、审计事件，各带一个死信主题。 */
  ensureTopics(): Promise<void> {
    this.topicsReady ??= (async () => {
      const cfg = kafkaConfig();
      const admin = this.client.admin();
      await withTimeout(admin.connect(), 10_000, "Kafka admin connect");
      try {
        await admin.createTopics({ topics: Object.values(cfg.topics).map((topic) => ({ topic, numPartitions: topic.endsWith(".dlq") ? 1 : cfg.partitions })) });
      } finally {
        await admin.disconnect().catch(() => undefined);
      }
    })().catch((err) => {
      this.topicsReady = null; // 下次再试
      throw err;
    });
    return this.topicsReady;
  }

  private async ready(): Promise<KafkaJS.Producer> {
    this.producerReady ??= (async () => {
      await this.ensureTopics();
      const p = this.client.producer({ kafkaJS: { acks: -1, idempotent: true, allowAutoTopicCreation: false } });
      await withTimeout(p.connect(), 10_000, "Kafka producer connect");
      this.producer = p;
      return p;
    })().catch((err) => {
      this.producerReady = null;
      throw err;
    });
    return this.producerReady;
  }

  /** 发一条消息，等 Kafka 确认（失败抛错，调用方保留事件稍后重发）。 */
  async publish(topic: string, key: string, value: unknown, headers: Record<string, string> = {}): Promise<void> {
    const producer = await this.ready();
    await withTimeout(producer.send({ topic, messages: [{ key, value: JSON.stringify(value), headers }] }), 10_000, "Kafka send");
  }

  async publishEvent(topic: string, event: EventEnvelope): Promise<void> {
    await this.publish(topic, event.key, event, { type: event.type, "tenant-id": event.tenantId, "event-id": event.id });
  }

  /**
   * 消费者：每条消息处理失败就重试，试完仍失败就连同失败原因发到死信主题，然后继续（不卡住后面的消息）。
   * 同一个消费组的多个实例按分区分工；同一个分区里的消息按顺序处理。
   */
  async consume(opts: ConsumerOptions): Promise<void> {
    await this.ensureTopics();
    const consumer = this.client.consumer({ kafkaJS: { groupId: opts.groupId, fromBeginning: true, autoCommit: true } });
    await withTimeout(consumer.connect(), 10_000, "Kafka consumer connect");
    await consumer.subscribe({ topics: [opts.topic] });
    this.consumers.push(consumer);
    const attempts = opts.attempts ?? 3;
    await consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        const raw = message.value?.toString() ?? "";
        let event: EventEnvelope | null = null;
        let failure: unknown = null;
        try {
          const parsed = JSON.parse(raw) as EventEnvelope;
          if (!parsed?.id || !parsed.type || !parsed.tenantId) throw new Error("not an event envelope");
          event = parsed; // 格式合格才交给处理逻辑；不合格的直接进死信主题，不重试
        } catch (err) {
          failure = err;
        }
        for (let attempt = 1; event && attempt <= attempts; attempt++) {
          try {
            await opts.handle(event);
            failure = null;
            break;
          } catch (err) {
            failure = err;
            if (attempt < attempts) await sleep(attempt * 200);
          }
        }
        if (failure) {
          const reason = String(failure instanceof Error ? failure.message : failure).slice(0, 500);
          this.log.warn(`event ${event?.id ?? "?"} sent to ${opts.dlqTopic}: ${reason}`);
          await this.publish(opts.dlqTopic, event?.key ?? `${topic}:${partition}`, { event, raw: event ? undefined : raw.slice(0, 2000), error: reason, attempts, source: { topic, partition, offset: message.offset, group: opts.groupId }, failedAt: new Date().toISOString() }, { error: reason.slice(0, 200) });
        }
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    for (const c of this.consumers) await c.disconnect().catch(() => undefined);
    await this.producer?.disconnect().catch(() => undefined);
  }
}
