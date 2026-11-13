// 泄露扫描的接口登记表。
// 规则：除了标了 @Public() 的接口，应用里每一个路由都必须登记在这里（读取、变更或"其他"三张表之一）
// ——否则 "every route is registered" 这个测试失败，逼着新接口的作者把它加进扫描。
//
// 读取（LEAK_REGISTRY）：
//   list    返回数组，里面每一行必须属于当前租户
//   detail  按 id 取一行；用 B 的 id 在 A 的网址上取，必须是 404
//   self    返回当前账号自己的信息
//   other   其他结构的读取；只检查"B 的 id 一个都不能出现"
// 变更（MUTATION_REGISTRY）：在 A 的网址上，用 A 的令牌，对 B 的行（或带着 B 的关联 id）发起写操作，
//   必须被拒绝（400/403/404），并且 B 的数据一行都没变（外键不受行级安全约束，靠接口自己校验）。
// 其他（OTHER_ROUTES）：只作用于调用者自己的租户、且不接收任何别人的 id 的写接口，写明理由。

export type Fixture =
  | "campusId"
  | "deptId"
  | "postId"
  | "roleId"
  | "accountId"
  | "personId"
  | "menuId"
  | "setId"
  | "termId"
  | "courseId"
  | "majorId"
  | "sectionId"
  | "dictTypeId"
  | "dictItemId"
  | "paramId"
  | "sid";

export interface LeakEntry {
  method: "GET";
  path: string;
  kind: "list" | "detail" | "self" | "other";
  /** detail 用：取哪个夹具里的 id */
  fixture?: Fixture;
}

export const LEAK_REGISTRY: LeakEntry[] = [
  { method: "GET", path: "/api/me", kind: "self" },
  { method: "GET", path: "/api/me/menus?entry=admin", kind: "other" },
  { method: "GET", path: "/api/campuses", kind: "list" },
  { method: "GET", path: "/api/campuses/:id", kind: "detail", fixture: "campusId" },
  { method: "GET", path: "/api/campuses/:id/closure-check", kind: "detail", fixture: "campusId" },
  { method: "GET", path: "/api/dict-types", kind: "other" },
  { method: "GET", path: "/api/dict-types/:id/items", kind: "detail", fixture: "dictTypeId" },
  { method: "GET", path: "/api/dicts/:code", kind: "other" },
  { method: "GET", path: "/api/params", kind: "other" },
  { method: "GET", path: "/api/operation-logs", kind: "other" },
  { method: "GET", path: "/api/staff", kind: "list" },
  { method: "GET", path: "/api/staff/:id", kind: "detail", fixture: "personId" },
  { method: "GET", path: "/api/staff/export", kind: "other" },
  { method: "GET", path: "/api/students", kind: "other" },
  { method: "GET", path: "/api/students/export", kind: "other" },
  { method: "GET", path: "/api/terms", kind: "other" },
  { method: "GET", path: "/api/terms/:id", kind: "detail", fixture: "termId" },
  { method: "GET", path: "/api/courses", kind: "other" },
  { method: "GET", path: "/api/courses/:id", kind: "detail", fixture: "courseId" },
  { method: "GET", path: "/api/majors", kind: "other" },
  { method: "GET", path: "/api/majors/:id", kind: "detail", fixture: "majorId" },
  { method: "GET", path: "/api/majors/:id/students", kind: "other", fixture: "majorId" },
  { method: "GET", path: "/api/sections", kind: "other" },
  { method: "GET", path: "/api/depts", kind: "list" },
  { method: "GET", path: "/api/depts/:id", kind: "detail", fixture: "deptId" },
  { method: "GET", path: "/api/posts", kind: "list" },
  { method: "GET", path: "/api/posts/:id", kind: "detail", fixture: "postId" },
  { method: "GET", path: "/api/roles", kind: "list" },
  { method: "GET", path: "/api/roles/menu-tree", kind: "other" },
  { method: "GET", path: "/api/roles/:id", kind: "detail", fixture: "roleId" },
  { method: "GET", path: "/api/menus", kind: "other" },
  { method: "GET", path: "/api/entries", kind: "other" },
  { method: "GET", path: "/api/data-scope-sets", kind: "other" },
  { method: "GET", path: "/api/accounts", kind: "list" },
  { method: "GET", path: "/api/accounts/:id", kind: "detail", fixture: "accountId" },
  { method: "GET", path: "/api/persons", kind: "list" },
  { method: "GET", path: "/api/persons/:id", kind: "detail", fixture: "personId" },
  { method: "GET", path: "/api/online", kind: "other" },
  { method: "GET", path: "/api/login-logs", kind: "other" },
  { method: "GET", path: "/api/audit-logs", kind: "other" },
];

export interface MutationEntry {
  /** GET 用于"必须被拒"的敏感读取（如紧急联系人：租户管理员对自己租户的人也读不到，所以不放在普通读取表里） */
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** 期望的状态码；默认：别人的行 404、自己的行带着别人的关联 id 400 */
  expectStatus?: number;
  /** 路径模板：:id 换成 `target`（A 或 B）的夹具 id */
  path: string;
  /** :id 取哪个夹具；没有 :id 的写 undefined */
  fixture?: Fixture;
  /** 夹具属于谁：foreign = B 的行（必须被拒）；own = A 的行但请求体里带着 B 的 id */
  target: "foreign" | "own";
  /** 请求体；字符串里的 `{{B.xxx}}` 换成 B 的夹具 id */
  body?: unknown;
  note: string;
}

export const MUTATION_REGISTRY: MutationEntry[] = [
  // 目标行是 B 的
  { method: "PATCH", path: "/api/roles/:id", fixture: "roleId", target: "foreign", body: { name: "hacked" }, note: "rename another tenant's role" },
  { method: "DELETE", path: "/api/roles/:id", fixture: "roleId", target: "foreign", note: "delete another tenant's role" },
  { method: "PUT", path: "/api/roles/:id/menus", fixture: "roleId", target: "foreign", body: { menuIds: [] }, note: "clear another tenant's role menus" },
  { method: "PUT", path: "/api/roles/:id/data-scopes", fixture: "roleId", target: "foreign", body: { setIds: [] }, note: "clear another tenant's role scopes" },
  { method: "PATCH", path: "/api/menus/:id", fixture: "menuId", target: "foreign", body: { name: "hacked" }, note: "rename another tenant's menu" },
  { method: "DELETE", path: "/api/menus/:id", fixture: "menuId", target: "foreign", note: "delete another tenant's menu" },
  { method: "PUT", path: "/api/data-scope-sets/:id", fixture: "setId", target: "foreign", body: { name: "hacked", nodes: [{ deptId: "{{A.deptId}}", includeChildren: true }] }, note: "rewrite another tenant's data scope" },
  { method: "DELETE", path: "/api/data-scope-sets/:id", fixture: "setId", target: "foreign", note: "delete another tenant's data scope" },
  { method: "PATCH", path: "/api/accounts/:id/status", fixture: "accountId", target: "foreign", body: { status: "disabled" }, note: "disable another tenant's account" },
  { method: "PATCH", path: "/api/accounts/:id/email", fixture: "accountId", target: "foreign", body: { email: "x@example.test" }, note: "change another tenant's account email" },
  { method: "PUT", path: "/api/accounts/:id/roles", fixture: "accountId", target: "foreign", body: { roleIds: [] }, note: "change another tenant's account roles" },
  { method: "PATCH", path: "/api/persons/:id", fixture: "personId", target: "foreign", body: { fullName: "hacked" }, note: "edit another tenant's person" },
  { method: "DELETE", path: "/api/online/:sid", fixture: "sid", target: "foreign", note: "force logout another tenant's session" },
  { method: "PATCH", path: "/api/campuses/:id", fixture: "campusId", target: "foreign", body: { name: "hacked" }, note: "rename another tenant's campus" },
  { method: "POST", path: "/api/campuses/:id/status", fixture: "campusId", target: "foreign", body: { status: "stop_new" }, note: "change another tenant's campus status" },
  { method: "PATCH", path: "/api/depts/:id", fixture: "deptId", target: "foreign", body: { name: "hacked" }, note: "rename another tenant's department" },
  { method: "DELETE", path: "/api/depts/:id", fixture: "deptId", target: "foreign", note: "delete another tenant's department" },
  { method: "PATCH", path: "/api/posts/:id", fixture: "postId", target: "foreign", body: { name: "hacked" }, note: "rename another tenant's post" },
  { method: "DELETE", path: "/api/posts/:id", fixture: "postId", target: "foreign", note: "delete another tenant's post" },
  { method: "PATCH", path: "/api/dict-types/:id", fixture: "dictTypeId", target: "foreign", body: { name: "hacked" }, note: "rename another tenant's dictionary" },
  { method: "DELETE", path: "/api/dict-types/:id", fixture: "dictTypeId", target: "foreign", note: "delete another tenant's dictionary" },
  { method: "POST", path: "/api/dict-types/:id/items", fixture: "dictTypeId", target: "foreign", body: { value: "x", label: "X" }, note: "add an item to another tenant's dictionary" },
  { method: "PATCH", path: "/api/dict-items/:id", fixture: "dictItemId", target: "foreign", body: { label: "hacked" }, note: "edit another tenant's dictionary item" },
  { method: "DELETE", path: "/api/dict-items/:id", fixture: "dictItemId", target: "foreign", note: "delete another tenant's dictionary item" },
  { method: "PATCH", path: "/api/params/:id", fixture: "paramId", target: "foreign", body: { value: "hacked" }, note: "edit another tenant's parameter" },
  { method: "DELETE", path: "/api/params/:id", fixture: "paramId", target: "foreign", note: "delete another tenant's parameter" },
  { method: "POST", path: "/api/accounts/:id/invite", fixture: "accountId", target: "foreign", note: "resend an invitation for another tenant's account" },
  { method: "POST", path: "/api/accounts/:id/reset-link", fixture: "accountId", target: "foreign", note: "send a reset link for another tenant's account" },
  { method: "POST", path: "/api/accounts/:id/temp-password", fixture: "accountId", target: "foreign", note: "set a temporary password on another tenant's account" },
  { method: "POST", path: "/api/accounts/:id/unlock", fixture: "accountId", target: "foreign", note: "unlock another tenant's account" },
  { method: "GET", path: "/api/students/:id", fixture: "personId", target: "foreign", note: "read another tenant's student" },
  { method: "PATCH", path: "/api/students/:id", fixture: "personId", target: "foreign", body: { academicStatus: "withdrawn" }, note: "change another tenant's student" },
  { method: "PATCH", path: "/api/staff/:id", fixture: "personId", target: "foreign", body: { employmentType: "part_time" }, note: "edit another tenant's staff profile" },
  { method: "POST", path: "/api/staff/:id/assignments", fixture: "personId", target: "foreign", body: { deptId: "{{A.deptId}}" }, note: "assign another tenant's staff to a department" },
  { method: "POST", path: "/api/staff/:id/transfer", fixture: "personId", target: "foreign", body: { fromAssignmentId: "11111111-1111-4111-8111-111111111111", deptId: "{{A.deptId}}" }, note: "transfer another tenant's staff" },
  { method: "POST", path: "/api/staff/:id/end", fixture: "personId", target: "foreign", body: { status: "left" }, note: "end another tenant's staff employment" },
  { method: "POST", path: "/api/staff/:id/reinstate", fixture: "personId", target: "foreign", note: "reinstate another tenant's staff" },
  { method: "GET", path: "/api/persons/:personId/emergency-contacts", fixture: "personId", target: "foreign", note: "read another tenant's emergency contacts" },
  { method: "POST", path: "/api/persons/:personId/emergency-contacts", fixture: "personId", target: "foreign", body: { name: "X", relationship: "friend", phone: "123456" }, note: "add an emergency contact to another tenant's person" },
  { method: "DELETE", path: "/api/staff/:id/assignments/:assignmentId", fixture: "personId", target: "foreign", note: "end an assignment of another tenant's staff" },
  { method: "PUT", path: "/api/persons/:personId/emergency-contacts/:id", fixture: "personId", target: "foreign", body: { name: "X", relationship: "friend", phone: "123456" }, note: "change another tenant's emergency contact" },
  { method: "DELETE", path: "/api/persons/:personId/emergency-contacts/:id", fixture: "personId", target: "foreign", note: "delete another tenant's emergency contact" },
  { method: "PATCH", path: "/api/terms/:id", fixture: "termId", target: "foreign", body: { name: "hacked" }, note: "rename another tenant's term" },
  { method: "POST", path: "/api/terms/:id/status", fixture: "termId", target: "foreign", body: { status: "enrolling" }, note: "change another tenant's term status" },
  { method: "PATCH", path: "/api/courses/:id", fixture: "courseId", target: "foreign", body: { name: "hacked" }, note: "rename another tenant's course" },
  { method: "PUT", path: "/api/courses/:id/prerequisites", fixture: "courseId", target: "foreign", body: { courseIds: [] }, note: "change another tenant's prerequisites" },
  { method: "PATCH", path: "/api/majors/:id", fixture: "majorId", target: "foreign", body: { name: "hacked" }, note: "rename another tenant's major" },
  { method: "PUT", path: "/api/majors/:id/courses", fixture: "majorId", target: "foreign", body: { items: [] }, note: "change another tenant's curriculum" },
  { method: "PUT", path: "/api/majors/:id/students/:personId", fixture: "majorId", target: "foreign", body: {}, note: "declare a major in another tenant" },
  { method: "DELETE", path: "/api/majors/:id/students/:personId", fixture: "majorId", target: "foreign", note: "undeclare a major in another tenant" },
  { method: "GET", path: "/api/sections/:id", fixture: "sectionId", target: "foreign", note: "read another tenant's section" },
  { method: "PATCH", path: "/api/sections/:id", fixture: "sectionId", target: "foreign", body: { capacity: 1 }, note: "change another tenant's section" },
  { method: "POST", path: "/api/sections/:id/status", fixture: "sectionId", target: "foreign", body: { status: "cancelled" }, note: "cancel another tenant's section" },
  { method: "PUT", path: "/api/sections/:id/instructors", fixture: "sectionId", target: "foreign", body: { items: [] }, note: "change another tenant's instructors" },
  { method: "GET", path: "/api/sections/:id/roster", fixture: "sectionId", target: "foreign", note: "read another tenant's roster" },
  { method: "POST", path: "/api/sections/:id/enrollments", fixture: "sectionId", target: "foreign", body: { studentIds: ["11111111-1111-4111-8111-111111111111"] }, note: "enrol students in another tenant's section" },
  { method: "DELETE", path: "/api/sections/:id/enrollments/:enrollmentId", fixture: "sectionId", target: "foreign", note: "remove an enrollment of another tenant" },
  { method: "GET", path: "/api/sections/:id/materials", fixture: "sectionId", target: "foreign", note: "read another tenant's materials" },
  { method: "POST", path: "/api/sections/:id/materials", fixture: "sectionId", target: "foreign", body: { title: "x", url: "https://example.test" }, note: "add material to another tenant's section" },
  { method: "PATCH", path: "/api/sections/:id/materials/:materialId", fixture: "sectionId", target: "foreign", body: { title: "x" }, note: "edit another tenant's material" },
  { method: "DELETE", path: "/api/sections/:id/materials/:materialId", fixture: "sectionId", target: "foreign", note: "delete another tenant's material" },
  { method: "POST", path: "/api/sections", target: "own", body: { courseId: "{{B.courseId}}", termId: "{{A.termId}}", campusId: "{{A.campusId}}", number: "01", capacity: 5 }, note: "section of another tenant's course" },
  { method: "POST", path: "/api/sections", target: "own", body: { courseId: "{{A.courseId}}", termId: "{{B.termId}}", campusId: "{{A.campusId}}", number: "02", capacity: 5 }, note: "section in another tenant's term" },
  { method: "POST", path: "/api/sections", target: "own", body: { courseId: "{{A.courseId}}", termId: "{{A.termId}}", campusId: "{{B.campusId}}", number: "03", capacity: 5 }, note: "section on another tenant's campus" },
  { method: "PUT", path: "/api/courses/:id/prerequisites", fixture: "courseId", target: "own", body: { courseIds: ["{{B.courseId}}"] }, note: "prerequisite from another tenant" },
  { method: "PUT", path: "/api/majors/:id/courses", fixture: "majorId", target: "own", body: { items: [{ courseId: "{{B.courseId}}", category: "required" }] }, note: "curriculum with another tenant's course" },
  { method: "POST", path: "/api/courses", target: "own", body: { code: "LEAK1", name: "x", credits: 1, deptId: "{{B.deptId}}" }, note: "course owned by another tenant's department" },
  // 目标行是 A 的，但请求体里带着 B 的关联 id（外键不受行级安全约束）
  { method: "POST", path: "/api/accounts", target: "own", body: { username: "leak.role", roleIds: ["{{B.roleId}}"] }, note: "create account with another tenant's role" },
  { method: "POST", path: "/api/accounts", target: "own", body: { username: "leak.person", personId: "{{B.personId}}" }, note: "create account linked to another tenant's person" },
  { method: "PUT", path: "/api/accounts/:id/roles", fixture: "accountId", target: "own", body: { roleIds: ["{{B.roleId}}"] }, note: "assign another tenant's role" },
  { method: "PUT", path: "/api/roles/:id/menus", fixture: "roleId", target: "own", body: { menuIds: ["{{B.menuId}}"] }, note: "tick another tenant's menu" },
  { method: "PUT", path: "/api/roles/:id/data-scopes", fixture: "roleId", target: "own", body: { setIds: ["{{B.setId}}"] }, note: "give a role another tenant's data scope" },
  { method: "POST", path: "/api/data-scope-sets", target: "own", body: { name: "leak", nodes: [{ deptId: "{{B.deptId}}", includeChildren: true }] }, note: "scope node on another tenant's department" },
  { method: "PUT", path: "/api/data-scope-sets/:id", fixture: "setId", target: "own", body: { name: "leak", nodes: [{ deptId: "{{B.deptId}}", includeChildren: true }] }, note: "rewrite own scope onto another tenant's department" },
  { method: "PUT", path: "/api/entries/:code/menus", target: "own", body: { menus: [{ menuId: "{{B.menuId}}", sort: 1 }] }, note: "assign another tenant's menu to an entry" },
  { method: "POST", path: "/api/staff", target: "own", body: { fullName: "Leak", hireDate: "2026-01-01", assignments: [{ deptId: "{{B.deptId}}" }] }, note: "new staff assigned to another tenant's department" },
  { method: "POST", path: "/api/staff", target: "own", expectStatus: 404, body: { personId: "{{B.personId}}", hireDate: "2026-01-01" }, note: "staff profile on another tenant's person" },
  { method: "POST", path: "/api/students", target: "own", body: { fullName: "Leak", campusId: "{{B.campusId}}" }, note: "student in another tenant's campus" },
  { method: "POST", path: "/api/depts", target: "own", body: { name: "leak", parentId: "{{B.deptId}}" }, note: "create a department under another tenant's department" },
  { method: "PATCH", path: "/api/depts/:id", fixture: "deptId", target: "own", body: { parentId: "{{B.deptId}}" }, note: "move own department under another tenant's department" },
  { method: "POST", path: "/api/menus", target: "own", body: { parentId: "{{B.menuId}}", name: "leak", type: "directory" }, note: "create a menu under another tenant's menu" },
];

/** 不接收别人的 id、只作用于调用者自己租户的写接口。 */
export const OTHER_ROUTES: Record<string, string> = {
  "POST /api/auth/session": "registers the caller's own session; body has only an entry code",
  "POST /api/roles": "creates a role in the caller's tenant from name/code only",
  "POST /api/menus": "tested above with a foreign parent id; otherwise creates in the caller's tenant",
  "POST /api/import/campuses": "bulk import into the caller's tenant from CSV text only",
  "POST /api/import/staff": "bulk import into the caller's tenant from CSV text only (campus codes are looked up inside the tenant)",
  "POST /api/import/students": "bulk import into the caller's tenant from CSV text only (campus codes are looked up inside the tenant)",
  "POST /api/terms": "creates a term in the caller's tenant from plain fields",
  "POST /api/majors": "creates a major from plain fields",
  "GET /api/portal/sections": "student portal: answers for the caller's own student record only; tested with students of two tenants in edu.e2e.spec.ts",
  "POST /api/portal/enrollments": "student portal: acts for the caller's own student record; section ids of other tenants are invisible (edu.e2e.spec.ts)",
  "DELETE /api/portal/enrollments/:id": "student portal: only the caller's own enrollments (edu.e2e.spec.ts)",
  "GET /api/portal/my-enrollments": "student portal: the caller's own enrollments only",
  "GET /api/portal/plan": "student portal: the caller's own plan only",
  "GET /api/portal/sections/:id/materials": "student portal: members of the section only (edu.e2e.spec.ts)",
  "POST /api/campuses": "creates a campus and its root department in the caller's tenant from plain fields",
  "POST /api/posts": "creates a post from plain fields",
  "POST /api/dict-types": "creates a dictionary in the caller's tenant from plain fields",
  "POST /api/params": "creates a parameter in the caller's tenant from plain fields",
  "DELETE /api/operation-logs": "clears the caller's own tenant's operation log (row-level security limits it to the tenant)",
  "POST /api/accounts/reconcile": "compares the caller's own tenant with its own Keycloak realm",
};
