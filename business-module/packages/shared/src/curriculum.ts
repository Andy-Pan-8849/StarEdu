// 培养方案版本（B16）：版本从某个入学年份起生效，到下一个版本生效前截止。
// 学生用入学年份落在的那个版本；早于最早版本的按最早版本（没有"空窗"）。
export interface VersionLike {
  id: string;
  effectiveYear: number;
}

export function resolveVersion<T extends VersionLike>(versions: readonly T[], entryYear: number): T | null {
  if (!versions.length) return null;
  const sorted = [...versions].sort((a, b) => a.effectiveYear - b.effectiveYear);
  let found = sorted[0]!;
  for (const v of sorted) if (v.effectiveYear <= entryYear) found = v;
  return found;
}

/** 版本适用的入学年份范围：[from, to]，to 为 null 表示一直到现在及以后；最早的版本 from 也为 null（覆盖更早的年份）。 */
export function versionRanges<T extends VersionLike>(versions: readonly T[]): Array<T & { from: number | null; to: number | null }> {
  const sorted = [...versions].sort((a, b) => a.effectiveYear - b.effectiveYear);
  return sorted.map((v, i) => ({ ...v, from: i === 0 ? null : v.effectiveYear, to: i === sorted.length - 1 ? null : sorted[i + 1]!.effectiveYear - 1 }));
}
