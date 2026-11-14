// 消费者：kafka 模式下，通知服务作为 business.events 的一个消费组，把事件变成通知（和出站箱模式用同一段处理逻辑）。
// B10 里 AI 模块会作为另一个消费组订阅同一个主题（各自的组各读一遍，互不影响）。
import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { NotifyWorker } from "../notify/notify-worker";
import { busMode, kafkaConfig } from "./event-bus";
import { KafkaService } from "./kafka.service";

@Injectable()
export class EventConsumers implements OnApplicationBootstrap {
  private readonly log = new Logger(EventConsumers.name);
  private started = false;

  constructor(
    private readonly kafka: KafkaService,
    private readonly worker: NotifyWorker,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (busMode() !== "kafka" || process.env.NOTIFY_WORKER === "off") return;
    // Kafka 暂时连不上不能让应用起不来：后台重试
    void this.startWithRetry();
  }

  private async startWithRetry(): Promise<void> {
    for (let delay = 2000; !this.started; delay = Math.min(delay * 2, 30_000)) {
      try {
        await this.start();
      } catch (err) {
        this.log.warn(`Kafka consumer not started yet (${err instanceof Error ? err.message : err}); retrying in ${delay} ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    const cfg = kafkaConfig();
    await this.kafka.consume({
      groupId: `${cfg.groupPrefix}.notifications`,
      topic: cfg.topics.business,
      dlqTopic: cfg.topics.businessDlq,
      handle: (e) => this.worker.handleEvent({ id: e.id, tenantId: e.tenantId, type: e.type, payload: e.payload }),
    });
    this.started = true;
  }
}
