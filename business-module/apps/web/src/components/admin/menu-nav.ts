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
