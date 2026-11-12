// 数据范围 → Prisma 查询条件。纯函数，单独测试。
// 规则：
//   - 范围是"全部"：不加条件；
//   - 否则把适用于这张表的维度各转成一个条件，取并集（OR）；
//   - 这张表不认的维度（没有对应映射）被忽略；
//   - 没有任何适用的条件 = 什么都看不到（返回恒假条件），不是"放行"。
export interface ResolvedScope {
  all: boolean;
  /** 已展开的部门 id（"本部门及以下"、自定义含下级都已展开成具体 id） */
  deptIds: string[];
  /** "仅本人"适用时的人员 id */
  selfPersonId: string | null;
  /** "本人任教/就读的班级"适用时的班级 id */
  classIds: string[];
  /** 内置租户管理员：业务数据范围为"无"，只能管教职员工的基础信息 */
  staffBasic: boolean;
}

export const EMPTY_SCOPE: ResolvedScope = { all: false, deptIds: [], selfPersonId: null, classIds: [], staffBasic: false };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Where = Record<string, any>;

export interface ScopeMapping {
  /** 部门维度：这张表怎样按部门 id 过滤 */
  dept?: (deptIds: string[]) => Where;
  self?: (personId: string) => Where;
  classes?: (classIds: string[]) => Where;
  /** 内置租户管理员可见的"教职员工基础信息"范围 */
  staffBasic?: Where;
}

/**
 * 恒假条件。注意：不能用 `{ OR: [] }`——Prisma 里顶层的空 OR 不匹配任何行，但嵌在 AND 里会被当作"没有条件"，
 * 等于放行所有行（测试里实测过）。`id IN ()` 在任何位置都恒假。
 */
export const MATCH_NOTHING: Where = { id: { in: [] } };

/** 返回 null 表示不需要加条件（全部范围）。 */
export function scopeWhere(scope: ResolvedScope, mapping: ScopeMapping): Where | null {
  if (scope.all) return null;
  const clauses: Where[] = [];
  if (mapping.dept && scope.deptIds.length > 0) clauses.push(mapping.dept(scope.deptIds));
  if (mapping.self && scope.selfPersonId) clauses.push(mapping.self(scope.selfPersonId));
  if (mapping.classes && scope.classIds.length > 0) clauses.push(mapping.classes(scope.classIds));
  if (mapping.staffBasic && scope.staffBasic) clauses.push(mapping.staffBasic);
  return clauses.length === 0 ? MATCH_NOTHING : { OR: clauses };
}

/** 把范围条件与原有条件合并。 */
export function withScope(where: Where | undefined, scope: ResolvedScope, mapping: ScopeMapping): Where {
  const s = scopeWhere(scope, mapping);
  if (!s) return where ?? {};
  return where ? { AND: [where, s] } : s;
}

/** 并集：多个角色/多个集的范围合并成一个。 */
export function unionScopes(parts: ResolvedScope[]): ResolvedScope {
  const out: ResolvedScope = { ...EMPTY_SCOPE, deptIds: [], classIds: [] };
  const depts = new Set<string>();
  const classes = new Set<string>();
  for (const p of parts) {
    out.all ||= p.all;
    out.staffBasic ||= p.staffBasic;
    out.selfPersonId ||= p.selfPersonId;
    p.deptIds.forEach((d) => depts.add(d));
    p.classIds.forEach((c) => classes.add(c));
  }
  out.deptIds = [...depts].sort();
  out.classIds = [...classes].sort();
  return out;
}
