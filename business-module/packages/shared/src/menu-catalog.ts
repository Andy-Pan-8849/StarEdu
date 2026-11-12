// 平台提供的菜单目录：目录 / 菜单 / 按钮，每条带稳定的 code 和权限码。
// 由"菜单同步"（apps/api 的 syncPlatformMenus）写进 menu 表（tenant_id 为空 = 平台提供，租户只读）。
// 只有顶层条目带 entries：入口管理里把顶层菜单分配给哪个入口，子级跟随。
import { PERMS } from "./permissions";

export type CatalogMenuType = "directory" | "menu" | "button" | "link";
export type EntryCode = "admin" | "portal" | "platform";

export interface CatalogMenu {
  code: string;
  parent?: string;
  type: CatalogMenuType;
  /** 默认名称（英文）；界面按 nameKey 取各语言的文字 */
  name: string;
  nameKey: string;
  route?: string;
  /** 构建时打包的页面组件路径；没有注册该组件的菜单，前端外壳不显示 */
  component?: string;
  perms?: string;
  icon?: string;
  sort: number;
  entries?: EntryCode[];
}

function menuWithButtons(
  code: string,
  parent: string,
  name: string,
  route: string,
  sort: number,
  list: string,
  buttons: Array<[string, string, string]>, // [后缀, 名称, 权限码]
): CatalogMenu[] {
  const rows: CatalogMenu[] = [
    {
      code,
      parent,
      type: "menu",
      name,
      nameKey: `menu.${code}`,
      route,
      component: `${code.replace(/:/g, "/")}/index`,
      perms: list,
      sort,
    },
  ];
  buttons.forEach(([suffix, label, perm], i) =>
    rows.push({ code: `${code}:${suffix}`, parent: code, type: "button", name: label, nameKey: `menu.${code}.${suffix}`, perms: perm, sort: i + 1 }),
  );
  return rows;
}

export const MENU_CATALOG: CatalogMenu[] = [
  { code: "system", type: "directory", name: "System management", nameKey: "menu.system", route: "system", icon: "settings", sort: 90, entries: ["admin"] },
  ...menuWithButtons("system:user", "system", "Accounts", "user", 1, PERMS.userList, [
    ["add", "Add", PERMS.userAdd],
    ["edit", "Edit", PERMS.userEdit],
    ["assignRole", "Assign roles", PERMS.userAssignRole],
    ["reconcile", "Reconcile", PERMS.userReconcile],
  ]),
  ...menuWithButtons("system:role", "system", "Roles", "role", 2, PERMS.roleList, [
    ["add", "Add", PERMS.roleAdd],
    ["edit", "Edit", PERMS.roleEdit],
    ["remove", "Remove", PERMS.roleRemove],
    ["authorize", "Permissions and data scope", PERMS.roleAuthorize],
  ]),
  ...menuWithButtons("system:menu", "system", "Menus", "menu", 3, PERMS.menuList, [
    ["add", "Add", PERMS.menuAdd],
    ["edit", "Edit", PERMS.menuEdit],
    ["remove", "Remove", PERMS.menuRemove],
  ]),
  ...menuWithButtons("system:entry", "system", "Entry assignment", "entry", 4, PERMS.entryList, [["edit", "Assign", PERMS.entryEdit]]),
  ...menuWithButtons("system:dataScope", "system", "Data scopes", "data-scope", 5, PERMS.dataScopeList, [
    ["add", "Add", PERMS.dataScopeAdd],
    ["edit", "Edit", PERMS.dataScopeEdit],
    ["remove", "Remove", PERMS.dataScopeRemove],
  ]),
  ...menuWithButtons("system:dept", "system", "Departments", "dept", 6, PERMS.deptList, []),
  ...menuWithButtons("system:campus", "system", "Campuses", "campus", 7, PERMS.campusList, []),
  ...menuWithButtons("system:post", "system", "Posts", "post", 8, PERMS.postList, []),
  ...menuWithButtons("system:online", "system", "Online users", "online", 9, PERMS.onlineList, [["forceLogout", "Force logout", PERMS.onlineForceLogout]]),
  ...menuWithButtons("system:loginLog", "system", "Login log", "login-log", 10, PERMS.loginLogList, []),
  ...menuWithButtons("system:auditLog", "system", "Audit log", "audit-log", 11, PERMS.auditLogList, []),

  { code: "hr", type: "directory", name: "Human resources", nameKey: "menu.hr", route: "hr", icon: "users", sort: 10, entries: ["admin"] },
  ...menuWithButtons("hr:person", "hr", "People", "person", 1, PERMS.hrPersonList, [["edit", "Edit", PERMS.hrPersonEdit]]),
];

/** 菜单所在入口：顶层条目的 entries。 */
export function entriesOf(code: string): EntryCode[] {
  const byCode = new Map(MENU_CATALOG.map((m) => [m.code, m]));
  let cur = byCode.get(code);
  while (cur?.parent) cur = byCode.get(cur.parent);
  return cur?.entries ?? [];
}
