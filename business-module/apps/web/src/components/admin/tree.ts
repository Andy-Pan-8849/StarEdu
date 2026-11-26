// 树形勾选的纯逻辑（角色编辑页的菜单树、数据权限集的组织树共用），单独测试。
export interface TreeNode {
  id: string;
  label: string;
  children?: TreeNode[];
}

export type CheckState = "checked" | "half" | "unchecked";

export function descendantIds(node: TreeNode): string[] {
  return (node.children ?? []).flatMap((c) => [c.id, ...descendantIds(c)]);
}

export function findNode(nodes: TreeNode[], id: string): TreeNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findNode(n.children ?? [], id);
    if (hit) return hit;
  }
  return undefined;
}

/** 一个节点的勾选状态：叶子看自己；有子节点时，全部勾选=已勾选，部分=半选。 */
export function stateOf(node: TreeNode, checked: ReadonlySet<string>): CheckState {
  const kids = node.children ?? [];
  if (kids.length === 0) return checked.has(node.id) ? "checked" : "unchecked";
  const states = kids.map((k) => stateOf(k, checked));
  if (states.every((s) => s === "checked")) return "checked";
  if (states.every((s) => s === "unchecked")) return "unchecked";
  return "half";
}

/** 点击一个节点：级联模式下连同全部下级一起勾选/取消；独立模式只改自己。 */
export function toggle(nodes: TreeNode[], checked: ReadonlySet<string>, id: string, cascade: boolean): Set<string> {
  const node = findNode(nodes, id);
  const next = new Set(checked);
  if (!node) return next;
  const turnOn = cascade ? stateOf(node, checked) !== "checked" : !checked.has(id);
  const targets = cascade ? [id, ...descendantIds(node)] : [id];
  for (const t of targets) {
    if (turnOn) next.add(t);
    else next.delete(t);
  }
  return next;
}

/**
 * 提交给后端的 id：已勾选的加上半选的祖先（目录），和竞品的做法一致。
 * 后端按"勾选且生效的菜单"算权限，目录本身没有权限字符，多带上不会放大权限。
 */
export function submitIds(nodes: TreeNode[], checked: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  const walk = (node: TreeNode) => {
    const s = stateOf(node, checked);
    if (s !== "unchecked") out.add(node.id);
    (node.children ?? []).forEach(walk);
  };
  nodes.forEach(walk);
  return [...out];
}

/** 把几棵树的顶层拼在一起；同一个菜单分配给了多个入口（如 AI 助手同时在管理端和门户）只保留第一次出现的，id 不能重复。 */
export function mergeTopLevel(...trees: TreeNode[][]): TreeNode[] {
  const seen = new Set<string>();
  const out: TreeNode[] = [];
  for (const node of trees.flat()) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  return out;
}
