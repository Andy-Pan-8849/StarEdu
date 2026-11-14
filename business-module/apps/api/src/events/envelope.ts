// 事件信封：发到 Kafka 的统一格式。版本号用来以后改格式；tenant_id 必带，消费者按租户处理；
// 分区键 = 租户 + 聚合 id（班级、账号……），同一个对象的事件落在同一个分区，保证有序。
// 载荷里只放 id 和少量枚举值，不放密码、令牌、个人敏感信息（发送前有检查）。
import { kafkaConfig } from "./event-bus";

export interface EventEnvelope {
  id: string;
  type: string;
  version: 1;
  tenantId: string;
  /** 租户代码：消费者（如 AI 模块）按它找到该租户的业务模块地址 */
  tenantCode?: string;
  occurredAt: string;
  /** 分区键 */
  key: string;
  payload: Record<string, unknown>;
}

export interface OutboxLike {
  id: string;
  tenantId: string;
  type: string;
  payload: unknown;
  createdAt: Date;
}

const AGGREGATE_FIELDS = ["sectionId", "assignmentId", "enrollmentId", "postId", "accountId", "studentPersonId", "targetId"] as const;

/** 这个事件属于哪个聚合（决定分区键）；找不到就用事件自己的 id（各自独立，不要求顺序）。 */
export function aggregateOf(type: string, payload: unknown, fallback: string): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  for (const f of AGGREGATE_FIELDS) if (typeof p[f] === "string" && p[f]) return `${type.split(".")[0]}:${p[f] as string}`;
  return fallback;
}

export function toEnvelope(row: OutboxLike, tenantCode?: string): EventEnvelope {
  return { id: row.id, type: row.type, version: 1, tenantId: row.tenantId, ...(tenantCode ? { tenantCode } : {}), occurredAt: row.createdAt.toISOString(), key: `${row.tenantId}:${aggregateOf(row.type, row.payload, row.id)}`, payload: (row.payload ?? {}) as Record<string, unknown> };
}

/** 审计类事件走 audit.events，其余走 business.events。 */
export const topicFor = (type: string): string => (type.startsWith("audit.") ? kafkaConfig().topics.audit : kafkaConfig().topics.business);

const FORBIDDEN_KEY = /pass(word)?|secret|token|authorization|credential|id_?number|phone|e-?mail|address|birth/i;
const EMAIL_VALUE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/** 载荷里不能有敏感的字段名，也不能有长得像邮箱的值；有问题返回原因。 */
export function unsafePayload(value: unknown, path = "payload"): string | null {
  if (typeof value === "string") return EMAIL_VALUE.test(value) ? `${path} looks like an e-mail address` : null;
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const problem = unsafePayload(v, `${path}[${i}]`);
      if (problem) return problem;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(k)) return `${path}.${k} is a sensitive field name`;
      const problem = unsafePayload(v, `${path}.${k}`);
      if (problem) return problem;
    }
  }
  return null;
}
