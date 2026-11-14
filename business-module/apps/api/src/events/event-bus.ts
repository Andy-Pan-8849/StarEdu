// 事件总线的配置。出站箱（outbox_event 表）始终是唯一的事件出口：
//   BIZ_EVENT_BUS=outbox（默认）：由进程内的消费者直接处理出站箱里的事件（B9 的行为，不需要任何额外服务）。
//   BIZ_EVENT_BUS=kafka：出站箱里的事件由"转发器"发到 Kafka，再由消费组处理；Kafka 不可用时事件留在表里，恢复后补发。
export type BusMode = "outbox" | "kafka";

export const busMode = (): BusMode => (process.env.BIZ_EVENT_BUS === "kafka" ? "kafka" : "outbox");

/** 只有 kafka 模式才多发的事件类型（账号变更、选课/退课、审计），默认模式下行为和 B9 完全一致。 */
export const extendedEvents = (): boolean => busMode() === "kafka";

export function kafkaConfig() {
  const prefix = process.env.KAFKA_TOPIC_PREFIX ?? "";
  return {
    brokers: (process.env.KAFKA_BROKERS ?? "localhost:9094").split(",").map((s) => s.trim()),
    clientId: process.env.KAFKA_CLIENT_ID ?? "staredu-business",
    partitions: Number(process.env.KAFKA_PARTITIONS) > 0 ? Number(process.env.KAFKA_PARTITIONS) : 3,
    groupPrefix: process.env.KAFKA_GROUP_PREFIX ?? "staredu",
    topics: {
      business: `${prefix}business.events`,
      businessDlq: `${prefix}business.events.dlq`,
      audit: `${prefix}audit.events`,
      auditDlq: `${prefix}audit.events.dlq`,
    },
  };
}
