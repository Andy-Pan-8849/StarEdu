// 操作日志的参数脱敏（纯函数，单独测试）：
//   - 键名像密码、令牌、证件号、电话等的值一律替换为 ***；
//   - 太长的字符串截断，整体超过上限就只留一句说明；
//   - 返回内容永远不记。
const SENSITIVE = /pass(word|wd)?|secret|token|authorization|credential|cookie|id.?card|passport|ssn|phone|mobile|salary|apikey|api.?key/i;
const MAX_STRING = 300;
const MAX_TOTAL = 4000;
const MAX_DEPTH = 6;

export function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(${value.length} chars)` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_DEPTH) return "[too deep]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SENSITIVE.test(k) ? "***" : sanitize(v, depth + 1);
    return out;
  }
  return String(value);
}

/** 整体大小受限：超过就只留键名。 */
export function sanitizeParams(params: { body?: unknown; query?: unknown }): unknown {
  const cleaned = { body: sanitize(params.body), query: sanitize(params.query) };
  const text = JSON.stringify(cleaned);
  if (text.length <= MAX_TOTAL) return cleaned;
  const keys = (v: unknown) => (v && typeof v === "object" ? Object.keys(v as object) : []);
  return { truncated: true, bodyKeys: keys(params.body), queryKeys: keys(params.query) };
}
