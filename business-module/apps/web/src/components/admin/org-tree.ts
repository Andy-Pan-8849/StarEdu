// 组织架构树（纯逻辑）：
//   公司（虚拟根，不是部门）→ 总部校区 → 总部的办公部门…
//                          → 分校区（按建立时间排在总部后面）→ 该校区的部门…
// 数据库里总部和各分校区都是顶层部门；这里只负责排序和嵌套。
export interface DeptRow { id: string; name: string; parentId: string | null; sort: number; status: boolean; ancestors: string[]; createdAt?: string }
export interface CampusRow { id: string; deptId: string; name: string; type: "hq" | "campus"; createdAt?: string }

export const ROOT_ID = "__company__";

export type OrgKind = "root" | "hq" | "campus" | "dept";
export interface OrgNode { id: string; label: string; kind: OrgKind; disabled: boolean; children: OrgNode[] }

const time = (iso: string | undefined) => (iso ? Date.parse(iso) : 0);

/** 顶层部门的顺序：总部在最前，分校区按建立时间先后，其余顶层部门再按各自创建时间。 */
export function orderTop(depts: readonly DeptRow[], campuses: readonly CampusRow[]): DeptRow[] {
  const byDept = new Map(campuses.map((c) => [c.deptId, c]));
  const rank = (d: DeptRow) => {
    const c = byDept.get(d.id);
    return c?.type === "hq" ? 0 : c ? 1 : 2;
  };
  return depts
    .filter((d) => d.parentId === null)
    .sort((a, b) => rank(a) - rank(b) || time(byDept.get(a.id)?.createdAt ?? a.createdAt) - time(byDept.get(b.id)?.createdAt ?? b.createdAt) || a.name.localeCompare(b.name));
}

/** 某个部门的直接下级：同级按排序号，再按名字。 */
export function childDepts(parentId: string, depts: readonly DeptRow[]): DeptRow[] {
  return depts.filter((d) => d.parentId === parentId).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
}

export function buildOrgTree(depts: readonly DeptRow[], campuses: readonly CampusRow[], rootLabel: string): OrgNode {
  const byDept = new Map(campuses.map((c) => [c.deptId, c]));
  const build = (d: DeptRow, top: boolean): OrgNode => {
    const campus = byDept.get(d.id);
    return {
      id: d.id,
      label: d.name,
      kind: top && campus ? campus.type : "dept",
      disabled: !d.status,
      children: childDepts(d.id, depts).map((c) => build(c, false)),
    };
  };
  return { id: ROOT_ID, label: rootLabel, kind: "root", disabled: false, children: orderTop(depts, campuses).map((d) => build(d, true)) };
}

export function findOrg(node: OrgNode, id: string): OrgNode | undefined {
  if (node.id === id) return node;
  for (const c of node.children) {
    const hit = findOrg(c, id);
    if (hit) return hit;
  }
  return undefined;
}
