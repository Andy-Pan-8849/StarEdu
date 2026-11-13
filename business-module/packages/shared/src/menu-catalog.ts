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
    ["resetPwd", "Reset password", PERMS.userResetPwd],
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
  // 校区管理排在部门管理之前
  ...menuWithButtons("system:campus", "system", "Campuses", "campus", 6, PERMS.campusList, [
    ["add", "Add", PERMS.campusAdd],
    ["edit", "Edit", PERMS.campusEdit],
    ["close", "Change status", PERMS.campusClose],
  ]),
  ...menuWithButtons("system:dept", "system", "Departments", "dept", 7, PERMS.deptList, [
    ["add", "Add", PERMS.deptAdd],
    ["edit", "Edit", PERMS.deptEdit],
    ["remove", "Remove", PERMS.deptRemove],
  ]),
  ...menuWithButtons("system:post", "system", "Posts", "post", 8, PERMS.postList, [
    ["add", "Add", PERMS.postAdd],
    ["edit", "Edit", PERMS.postEdit],
    ["remove", "Remove", PERMS.postRemove],
  ]),
  ...menuWithButtons("system:dict", "system", "Dictionaries", "dict", 12, PERMS.dictList, [
    ["add", "Add", PERMS.dictAdd],
    ["edit", "Edit", PERMS.dictEdit],
    ["remove", "Remove", PERMS.dictRemove],
  ]),
  ...menuWithButtons("system:param", "system", "Parameters", "param", 13, PERMS.paramList, [
    ["add", "Add", PERMS.paramAdd],
    ["edit", "Edit", PERMS.paramEdit],
    ["remove", "Remove", PERMS.paramRemove],
  ]),
  ...menuWithButtons("system:operationLog", "system", "Operation log", "operation-log", 14, PERMS.operationLogList, [["clear", "Clear", PERMS.operationLogClear]]),
  ...menuWithButtons("system:online", "system", "Online users", "online", 9, PERMS.onlineList, [["forceLogout", "Force logout", PERMS.onlineForceLogout]]),
  ...menuWithButtons("system:loginLog", "system", "Login log", "login-log", 10, PERMS.loginLogList, []),
  ...menuWithButtons("system:auditLog", "system", "Audit log", "audit-log", 11, PERMS.auditLogList, []),

  // 平台入口（只分配给"平台"入口；租户的功能授权树里不出现）
  { code: "platform", type: "directory", name: "Platform", nameKey: "menu.platform", route: "platform", icon: "building", sort: 10, entries: ["platform"] },
  ...menuWithButtons("platform:tenant", "platform", "Tenants", "tenant", 1, PERMS.platformTenantList, [
    ["add", "Add", PERMS.platformTenantAdd],
    ["edit", "Edit", PERMS.platformTenantEdit],
    ["status", "Status", PERMS.platformTenantStatus],
    ["grant", "Features", PERMS.platformTenantGrant],
    ["admin", "Administrator", PERMS.platformTenantAdmin],
  ]),
  ...menuWithButtons("platform:account", "platform", "Platform accounts", "account", 2, PERMS.platformAccountList, [
    ["add", "Add", PERMS.platformAccountAdd],
    ["edit", "Edit", PERMS.platformAccountEdit],
    ["assignRole", "Assign roles", PERMS.platformAccountAssignRole],
  ]),
  ...menuWithButtons("platform:role", "platform", "Platform roles", "role", 3, PERMS.platformRoleList, [
    ["add", "Add", PERMS.platformRoleAdd],
    ["edit", "Edit", PERMS.platformRoleEdit],
    ["remove", "Remove", PERMS.platformRoleRemove],
    ["authorize", "Permissions", PERMS.platformRoleAuthorize],
  ]),
  ...menuWithButtons("platform:menu", "platform", "Menus", "menu", 4, PERMS.platformMenuList, [["edit", "Edit", PERMS.platformMenuEdit]]),
  ...menuWithButtons("platform:entry", "platform", "Entry assignment", "entry", 5, PERMS.platformEntryList, [["edit", "Assign", PERMS.platformEntryEdit]]),
  ...menuWithButtons("platform:monitor", "platform", "Monitoring", "monitor", 6, PERMS.platformMonitorList, []),
  ...menuWithButtons("platform:job", "platform", "Scheduled jobs", "job", 7, PERMS.platformJobList, [
    ["edit", "Edit", PERMS.platformJobEdit],
    ["run", "Run now", PERMS.platformJobRun],
  ]),
  ...menuWithButtons("platform:log", "platform", "Audit log", "log", 8, PERMS.platformLogList, []),

  { code: "edu", type: "directory", name: "Teaching", nameKey: "menu.edu", route: "edu", icon: "book", sort: 20, entries: ["admin"] },
  ...menuWithButtons("edu:term", "edu", "Terms", "term", 1, PERMS.eduTermList, [
    ["add", "Add", PERMS.eduTermAdd],
    ["edit", "Edit", PERMS.eduTermEdit],
  ]),
  ...menuWithButtons("edu:major", "edu", "Majors", "major", 2, PERMS.eduMajorList, [
    ["add", "Add", PERMS.eduMajorAdd],
    ["edit", "Edit", PERMS.eduMajorEdit],
  ]),
  ...menuWithButtons("edu:course", "edu", "Courses", "course", 3, PERMS.eduCourseList, [
    ["add", "Add", PERMS.eduCourseAdd],
    ["edit", "Edit", PERMS.eduCourseEdit],
  ]),
  ...menuWithButtons("edu:section", "edu", "Sections", "section", 4, PERMS.eduSectionList, [
    ["add", "Add", PERMS.eduSectionAdd],
    ["edit", "Edit", PERMS.eduSectionEdit],
    ["status", "Change status", PERMS.eduSectionStatus],
    ["roster", "Roster", PERMS.eduEnrollmentList],
    ["enroll", "Enroll students", PERMS.eduEnrollmentAdd],
    ["unenroll", "Remove students", PERMS.eduEnrollmentRemove],
    ["materials", "Course materials", PERMS.eduMaterialEdit],
  ]),

  // 学生门户：学生角色的权限就是这个入口下全部菜单和按钮的权限
  { code: "portal", type: "directory", name: "My studies", nameKey: "menu.portal", route: "studies", icon: "graduation", sort: 10, entries: ["portal"] },
  ...menuWithButtons("portal:enroll", "portal", "Course enrollment", "enroll", 1, PERMS.portalEnrollList, [
    ["add", "Enroll", PERMS.portalEnrollAdd],
    ["drop", "Drop", PERMS.portalEnrollDrop],
  ]),
  ...menuWithButtons("portal:plan", "portal", "Degree plan", "plan", 2, PERMS.portalPlanView, []),

  { code: "hr", type: "directory", name: "Human resources", nameKey: "menu.hr", route: "hr", icon: "users", sort: 10, entries: ["admin"] },
  ...menuWithButtons("hr:person", "hr", "People", "person", 1, PERMS.hrPersonList, [
    ["edit", "Edit", PERMS.hrPersonEdit],
    ["sensitive", "Sensitive information", PERMS.hrPersonSensitive],
    ["emergencyView", "View emergency contacts", PERMS.hrEmergencyView],
    ["emergencyEdit", "Edit emergency contacts", PERMS.hrEmergencyEdit],
  ]),
  ...menuWithButtons("hr:staff", "hr", "Staff", "staff", 2, PERMS.hrStaffList, [
    ["add", "Add", PERMS.hrStaffAdd],
    ["edit", "Edit", PERMS.hrStaffEdit],
    ["assign", "Assignments", PERMS.hrStaffAssign],
    ["end", "End employment", PERMS.hrStaffEnd],
    ["import", "Import", PERMS.hrStaffImport],
  ]),
  ...menuWithButtons("hr:student", "hr", "Students", "student", 3, PERMS.hrStudentList, [
    ["add", "Add", PERMS.hrStudentAdd],
    ["edit", "Edit", PERMS.hrStudentEdit],
    ["import", "Import", PERMS.hrStudentImport],
  ]),
];

/** 菜单所在入口：顶层条目的 entries。 */
export function entriesOf(code: string): EntryCode[] {
  const byCode = new Map(MENU_CATALOG.map((m) => [m.code, m]));
  let cur = byCode.get(code);
  while (cur?.parent) cur = byCode.get(cur.parent);
  return cur?.entries ?? [];
}
