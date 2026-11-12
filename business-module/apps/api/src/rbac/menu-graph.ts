// 菜单树的内存视图：一个租户能看到的菜单（平台提供的 + 本租户自建的）、功能授权、入口分配。
// 权限解析和"我的菜单树"共用，保证两边对"哪些菜单有效"的判断一致。
export interface GraphMenu {
  id: string;
  tenantId: string | null;
  parentId: string | null;
  name: string;
  nameKey: string | null;
  type: "directory" | "menu" | "button" | "link";
  route: string | null;
  component: string | null;
  perms: string | null;
  icon: string | null;
  sort: number;
  visible: boolean;
  status: boolean;
  code: string | null;
}

export class MenuGraph {
  readonly byId: Map<string, GraphMenu>;

  constructor(
    readonly menus: GraphMenu[],
    private readonly granted: Set<string>,
    /** entry id → entry code */
    private readonly entryCodes: Map<string, string>,
    private readonly assignments: Array<{ entryId: string; menuId: string; sort: number }>,
  ) {
    this.byId = new Map(menus.map((m) => [m.id, m]));
  }

  /** 菜单是否生效：自己和所有上级都启用；平台提供的部分还要本租户已开通（功能授权）。 */
  effective(id: string): boolean {
    let cur = this.byId.get(id);
    for (let guard = 0; guard < 50; guard += 1) {
      if (!cur || !cur.status) return false;
      if (cur.tenantId === null && !this.granted.has(cur.id)) return false;
      if (!cur.parentId) return true;
      cur = this.byId.get(cur.parentId);
    }
    return false; // 链断了（上级不存在或被删）
  }

  topOf(id: string): string {
    let cur = id;
    for (let guard = 0; guard < 50; guard += 1) {
      const p = this.byId.get(cur)?.parentId;
      if (!p || !this.byId.has(p)) return cur;
      cur = p;
    }
    return cur;
  }

  /** 分配给某入口的顶层菜单 id → 排序 */
  topsOfEntry(entryCode: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const a of this.assignments) {
      if (this.entryCodes.get(a.entryId) === entryCode) out.set(a.menuId, Math.min(a.sort, out.get(a.menuId) ?? a.sort));
    }
    return out;
  }

  /** 属于某入口且生效的全部菜单（含按钮）。 */
  menusOfEntry(entryCode: string): GraphMenu[] {
    const tops = this.topsOfEntry(entryCode);
    return this.menus.filter((m) => tops.has(this.topOf(m.id)) && this.effective(m.id));
  }

  /** 构造某入口的菜单树：只含 allowed 里的目录/菜单/外链（不含按钮），目录没有可见子项则不显示。 */
  tree(entryCode: string, allowed: (m: GraphMenu) => boolean, opts: { forEditor?: boolean } = {}): MenuNode[] {
    const tops = this.topsOfEntry(entryCode);
    const editor = opts.forEditor === true; // 角色编辑页：含按钮和隐藏的菜单，目录不管有没有子项
    const build = (m: GraphMenu): MenuNode | null => {
      if (!this.effective(m.id)) return null;
      if (!editor && (!m.visible || m.type === "button")) return null;
      const children = this.menus
        .filter((c) => c.parentId === m.id)
        .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
        .map(build)
        .filter((c): c is MenuNode => c !== null);
      if (m.type === "directory") {
        if (children.length === 0 && !editor) return null; // 空目录不显示
      } else if (!allowed(m)) return null;
      return {
        id: m.id,
        code: m.code,
        name: m.name,
        nameKey: m.nameKey,
        type: m.type,
        route: m.route,
        component: m.component,
        perms: m.perms,
        icon: m.icon,
        platformProvided: m.tenantId === null,
        children,
      };
    };
    return [...tops.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([id]) => this.byId.get(id))
      .filter((m): m is GraphMenu => !!m)
      .map(build)
      .filter((n): n is MenuNode => n !== null);
  }
}

export interface MenuNode {
  id: string;
  code: string | null;
  name: string;
  nameKey: string | null;
  type: "directory" | "menu" | "button" | "link";
  route: string | null;
  component: string | null;
  perms: string | null;
  icon: string | null;
  platformProvided: boolean;
  children: MenuNode[];
}
