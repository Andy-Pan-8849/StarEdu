// 迟交扣分：纯函数，不碰数据库。规则（需求 6.3，与 AI 样本《作业提交规则》TS-HW-006 一致）：
//   迟交 ≤24 小时扣 10%，≤48 小时扣 20%，≤72 小时扣 30%，超过 72 小时 0 分；扣分后 = 原始分 ×（1 − 扣分比例）。
// 表可以按作业调整。扣分后的分数取整到整数分，"四舍六入五成双"（样本里 75 分 × 70% = 52.5 记为 52，见黄金测试）；
// 没有扣分时原始分原样保留，不取整。
import { Prisma } from "../generated/prisma";
import { z } from "zod";

export interface LateTier {
  /** 迟交不超过多少小时 */
  upToHours: number;
  /** 扣多少个百分点（0–100） */
  pct: number;
}
export interface LatePolicy {
  tiers: LateTier[];
  /** 超过最后一档时扣多少个百分点 */
  beyondPct: number;
}

export const DEFAULT_LATE_POLICY: LatePolicy = {
  tiers: [
    { upToHours: 24, pct: 10 },
    { upToHours: 48, pct: 20 },
    { upToHours: 72, pct: 30 },
  ],
  beyondPct: 100,
};

export const latePolicySchema = z
  .object({
    tiers: z.array(z.object({ upToHours: z.number().positive().max(24 * 365), pct: z.number().min(0).max(100) })).max(10),
    beyondPct: z.number().min(0).max(100),
  })
  .refine((p) => p.tiers.every((t, i) => i === 0 || t.upToHours > p.tiers[i - 1].upToHours), { message: "tiers must be in increasing order of hours" })
  .refine((p) => p.tiers.every((t, i) => i === 0 || t.pct >= p.tiers[i - 1].pct), { message: "penalties must not decrease" })
  .refine((p) => p.tiers.length === 0 || p.beyondPct >= p.tiers[p.tiers.length - 1].pct, { message: "penalties must not decrease" });

const HOUR_MS = 3_600_000;

/** 迟交了多少小时（连续值，没迟交是 0）。 */
export function hoursLate(deadline: Date, submittedAt: Date): number {
  const ms = submittedAt.getTime() - deadline.getTime();
  return ms > 0 ? ms / HOUR_MS : 0;
}

/** 迟交这么多小时，扣多少个百分点。 */
export function penaltyPct(policy: LatePolicy, hours: number): number {
  if (hours <= 0) return 0;
  for (const tier of policy.tiers) if (hours <= tier.upToHours) return tier.pct;
  return policy.beyondPct;
}

/** 扣分后的得分。 */
export function applyPenalty(raw: Prisma.Decimal.Value, pct: number): Prisma.Decimal {
  const base = new Prisma.Decimal(raw);
  if (pct <= 0) return base;
  return base.mul(new Prisma.Decimal(100).minus(pct)).div(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_EVEN);
}
