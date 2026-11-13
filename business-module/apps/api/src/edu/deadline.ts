// 截止时间：截止日当天 23:59（含这一分钟），按班级所属校区的时区。
// 用 Intl 求时区偏移，夏令时切换日也正确；不引入日期库。

/** 某个时刻在时区 tz 里的偏移（分钟，东区为正）。 */
function offsetMinutes(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((wall - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** 日期（YYYY-MM-DD）当天 23:59:59.999 在时区 tz 里对应的时刻。 */
export function endOfLocalDay(day: string, tz: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`bad date ${day}`);
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  let guess = naive - offsetMinutes(new Date(naive), tz) * 60_000;
  guess = naive - offsetMinutes(new Date(guess), tz) * 60_000; // 偏移在切换点附近会变，再算一次
  return new Date(guess);
}
