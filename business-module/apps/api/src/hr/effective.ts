// "当前有效的任职"：开始日期 <= 今天，且没有结束日期或结束日期 >= 今天。日期按 UTC 的日历日算。
export function todayUtc(now = new Date()): Date {
  return new Date(now.toISOString().slice(0, 10));
}

export function effectiveWhere(today = todayUtc()) {
  return { startDate: { lte: today }, OR: [{ endDate: null }, { endDate: { gte: today } }] };
}

/** 'YYYY-MM-DD' → Date（UTC 零点）；格式不对返回 null。 */
export function parseDay(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 前一天（结束日期是"最后有效的一天"，今天结束 = 最后一天是昨天）。 */
export function dayBefore(d: Date): Date {
  return new Date(d.getTime() - 864e5);
}
