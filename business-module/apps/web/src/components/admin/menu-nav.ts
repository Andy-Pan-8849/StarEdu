// 后端 /api/me/menus 返回的菜单树，以及外壳用的小工具（纯函数）。
export interface MenuNode {
  id: string;
  code: string | null;
  name: string;
  nameKey: string | null;
  type: "directory" | "menu" | "link";
  route: string | null;
  component: string | null;
  icon: string | null;
  children: MenuNode[];
}

export function findMenu(nodes: readonly MenuNode[], id: string): MenuNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findMenu(n.children, id);
    if (hit) return hit;
  }
  return undefined;
}

/** 第一个可打开的菜单（用来默认打开首页标签）。 */
export function firstOpenable(nodes: readonly MenuNode[]): MenuNode | undefined {
  for (const n of nodes) {
    if (n.type === "menu") return n;
    const hit = firstOpenable(n.children);
    if (hit) return hit;
  }
  return undefined;
}

/** 按名字过滤菜单树：目录名命中保留整个目录，否则只保留命中的子项；空关键字原样返回。 */
export function filterMenus(nodes: readonly MenuNode[], query: string, label: (n: MenuNode) => string): MenuNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...nodes];
  const out: MenuNode[] = [];
  for (const n of nodes) {
    if (label(n).toLowerCase().includes(q)) {
      out.push(n);
    } else if (n.type === "directory") {
      const children = filterMenus(n.children, query, label);
      if (children.length > 0) out.push({ ...n, children });
    }
  }
  return out;
}
