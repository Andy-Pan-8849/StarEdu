// 租户配额（B15）：账号数、存储（MB）。上限为空 = 不限。纯函数，平台页面、接口和测试共用。
export interface QuotaLimits {
  maxAccounts: number | null;
  maxStorageMb: number | null;
}

export const QUOTA_LIMITS = { maxAccounts: { min: 1, max: 1_000_000 }, maxStorageMb: { min: 1, max: 100_000_000 } } as const;

export const BYTES_PER_MB = 1024 * 1024;

export interface QuotaMeter {
  used: number;
  limit: number | null;
  /** 已用占上限的百分比（取整，可以超过 100）；不限时为 null */
  percent: number | null;
  /** 已经用满（再增加就超限） */
  full: boolean;
  /** 已经超过上限（降低上限后可能出现；已有数据不删，只是拒绝新增） */
  over: boolean;
}

export function meter(used: number, limit: number | null): QuotaMeter {
  if (limit === null) return { used, limit, percent: null, full: false, over: false };
  return { used, limit, percent: Math.round((used / limit) * 100), full: used >= limit, over: used > limit };
}

/** 校验上限设置；返回问题列表（空 = 通过）。 */
export function quotaProblems(q: QuotaLimits): string[] {
  const out: string[] = [];
  for (const key of ["maxAccounts", "maxStorageMb"] as const) {
    const v = q[key];
    if (v === null) continue;
    const { min, max } = QUOTA_LIMITS[key];
    if (!Number.isInteger(v) || v < min || v > max) out.push(`${key} must be a whole number from ${min} to ${max}, or empty for no limit`);
  }
  return out;
}

/** 新增 `add` 个账号后会不会超过上限。 */
export function accountsWouldExceed(used: number, limit: number | null, add = 1): boolean {
  return limit !== null && used + add > limit;
}

/** 新增 `bytes` 字节后会不会超过存储上限。 */
export function storageWouldExceed(usedBytes: number, limitMb: number | null, bytes: number): boolean {
  return limitMb !== null && usedBytes + bytes > limitMb * BYTES_PER_MB;
}
