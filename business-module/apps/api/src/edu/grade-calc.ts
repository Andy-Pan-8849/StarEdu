// 成绩计算：纯函数，不碰数据库。规则见需求 6.4。
//   总评 = Σ（各作业分组的得分率 × 权重），权重合计 100%，保留一位小数（四舍五入，Decimal）。
//   分组得分率 = 组内各次作业得分之和 ÷ 满分之和（缺交按 0 分）。
//   等级表租户级：取最低百分比不超过总评的最高一档；带及格标记。
//   GPA = Σ（绩点 × 学分）÷ Σ 学分；不含退课（W）和进行中；重修取最新成绩，学分只算一次。
import { Prisma } from "../generated/prisma";

const D = Prisma.Decimal;

export interface ScaleItem {
  grade: string;
  minPercent: number;
  points: number;
  passing: boolean;
}

/** 默认等级表：A 90 / 4.0，B 80 / 3.0，C 70 / 2.0，D 60 / 1.0（及格线 D），F 0 / 0.0。 */
export const DEFAULT_SCALE: ScaleItem[] = [
  { grade: "A", minPercent: 90, points: 4, passing: true },
  { grade: "B", minPercent: 80, points: 3, passing: true },
  { grade: "C", minPercent: 70, points: 2, passing: true },
  { grade: "D", minPercent: 60, points: 1, passing: true },
  { grade: "F", minPercent: 0, points: 0, passing: false },
];

/** 等级表是否合法；返回错误信息（合法时为空数组）。 */
export function scaleProblems(items: ScaleItem[]): string[] {
  const out: string[] = [];
  if (items.length < 2) out.push("At least two grades are needed");
  const sorted = [...items].sort((a, b) => b.minPercent - a.minPercent);
  if (sorted.length && sorted[sorted.length - 1].minPercent !== 0) out.push("The lowest grade must start at 0%");
  if (new Set(items.map((i) => i.minPercent)).size !== items.length) out.push("Two grades start at the same percentage");
  if (new Set(items.map((i) => i.grade)).size !== items.length) out.push("Grade names must be different");
  for (let i = 1; i < sorted.length; i++) if (sorted[i].points > sorted[i - 1].points) out.push("Grade points must not rise as the percentage falls");
  const firstFail = sorted.findIndex((i) => !i.passing);
  if (firstFail >= 0 && sorted.slice(firstFail).some((i) => i.passing)) out.push("Passing grades must be the top grades (one pass line)");
  if (sorted.length && !sorted[0].passing) out.push("The top grade must be passing");
  return out;
}

/** 总评对应的等级。 */
export function gradeFor(scale: ScaleItem[], total: Prisma.Decimal.Value): ScaleItem {
  const t = new D(total);
  const sorted = [...scale].sort((a, b) => b.minPercent - a.minPercent);
  return sorted.find((s) => t.gte(s.minPercent)) ?? sorted[sorted.length - 1];
}

export interface GroupInput {
  name: string;
  /** 权重，百分点（可有两位小数） */
  weight: number;
  /** 组内每次作业：该生得分（缺交为 0）和满分 */
  items: Array<{ earned: Prisma.Decimal.Value; max: Prisma.Decimal.Value }>;
}

/** 成绩构成的问题：权重合计不是 100，或有权重的分组里没有作业。 */
export function policyProblems(groups: GroupInput[]): string[] {
  const out: string[] = [];
  const sum = groups.reduce((s, g) => s.plus(g.weight), new D(0));
  if (!sum.equals(100)) out.push(`Weights add up to ${sum.toString()}%, not 100%`);
  for (const g of groups) if (g.weight > 0 && g.items.every((i) => new D(i.max).lte(0))) out.push(`Group "${g.name}" has a weight but no scored assignment`);
  return out;
}

/** 总评（0–100，一位小数）。调用方应先用 policyProblems 确认没有问题。 */
export function finalTotal(groups: GroupInput[]): Prisma.Decimal {
  let total = new D(0);
  for (const g of groups) {
    if (g.weight <= 0) continue;
    const max = g.items.reduce((s, i) => s.plus(i.max), new D(0));
    if (max.lte(0)) continue;
    const earned = g.items.reduce((s, i) => s.plus(i.earned), new D(0));
    total = total.plus(earned.div(max).mul(g.weight));
  }
  return total.toDecimalPlaces(1, D.ROUND_HALF_UP);
}

export interface GpaRow {
  enrollmentId: string;
  courseId: string;
  termId: string;
  /** 学期开始日，用来判断谁是"最新" */
  termStart: Date;
  enrolledAt: Date;
  credits: number;
  points: number;
  passed: boolean;
}
export interface GpaResult {
  /** 计入的记录（每门课最新一次） */
  counted: string[];
  /** 被重修替代的旧记录 */
  replaced: string[];
  cumulative: { gpa: number | null; attempted: number; earned: number };
  byTerm: Record<string, { gpa: number | null; attempted: number; earned: number }>;
}

const gpaOf = (rows: GpaRow[]) => {
  const attempted = rows.reduce((s, r) => s.plus(r.credits), new D(0));
  const weighted = rows.reduce((s, r) => s.plus(new D(r.points).mul(r.credits)), new D(0));
  const earned = rows.filter((r) => r.passed).reduce((s, r) => s.plus(r.credits), new D(0));
  return { gpa: attempted.gt(0) ? weighted.div(attempted).toDecimalPlaces(2, D.ROUND_HALF_UP).toNumber() : null, attempted: attempted.toNumber(), earned: earned.toNumber() };
};

/** 传入的都应是已发布最终成绩的记录（退课 W 和进行中的不要传）。重修：同一门课取最新一次，学分只算一次。 */
export function computeGpa(rows: GpaRow[]): GpaResult {
  const latest = new Map<string, GpaRow>();
  for (const r of rows) {
    const cur = latest.get(r.courseId);
    if (!cur || r.termStart.getTime() > cur.termStart.getTime() || (r.termStart.getTime() === cur.termStart.getTime() && r.enrolledAt.getTime() > cur.enrolledAt.getTime())) latest.set(r.courseId, r);
  }
  const counted = [...latest.values()];
  const countedIds = new Set(counted.map((r) => r.enrollmentId));
  const byTerm: GpaResult["byTerm"] = {};
  for (const termId of new Set(counted.map((r) => r.termId))) byTerm[termId] = gpaOf(counted.filter((r) => r.termId === termId));
  return { counted: [...countedIds], replaced: rows.filter((r) => !countedIds.has(r.enrollmentId)).map((r) => r.enrollmentId), cumulative: gpaOf(counted), byTerm };
}
