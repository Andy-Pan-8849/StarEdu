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
  method: "POST" | "PUT" | "PATCH" | "DELETE";
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
  // 目标行是 A 的，但请求体里带着 B 的关联 id（外键不受行级安全约束）
  { method: "POST", path: "/api/accounts", target: "own", body: { username: "leak.role", roleIds: ["{{B.roleId}}"] }, note: "create account with another tenant's role" },
  { method: "POST", path: "/api/accounts", target: "own", body: { username: "leak.person", personId: "{{B.personId}}" }, note: "create account linked to another tenant's person" },
  { method: "PUT", path: "/api/accounts/:id/roles", fixture: "accountId", target: "own", body: { roleIds: ["{{B.roleId}}"] }, note: "assign another tenant's role" },
  { method: "PUT", path: "/api/roles/:id/menus", fixture: "roleId", target: "own", body: { menuIds: ["{{B.menuId}}"] }, note: "tick another tenant's menu" },
  { method: "PUT", path: "/api/roles/:id/data-scopes", fixture: "roleId", target: "own", body: { setIds: ["{{B.setId}}"] }, note: "give a role another tenant's data scope" },
  { method: "POST", path: "/api/data-scope-sets", target: "own", body: { name: "leak", nodes: [{ deptId: "{{B.deptId}}", includeChildren: true }] }, note: "scope node on another tenant's department" },
  { method: "PUT", path: "/api/data-scope-sets/:id", fixture: "setId", target: "own", body: { name: "leak", nodes: [{ deptId: "{{B.deptId}}", includeChildren: true }] }, note: "rewrite own scope onto another tenant's department" },
  { method: "PUT", path: "/api/entries/:code/menus", target: "own", body: { menus: [{ menuId: "{{B.menuId}}", sort: 1 }] }, note: "assign another tenant's menu to an entry" },
  { method: "POST", path: "/api/depts", target: "own", body: { name: "leak", parentId: "{{B.deptId}}" }, note: "create a department under another tenant's department" },
  { method: "PATCH", path: "/api/depts/:id", fixture: "deptId", target: "own", body: { parentId: "{{B.deptId}}" }, note: "move own department under another tenant's department" },
  { method: "POST", path: "/api/menus", target: "own", body: { parentId: "{{B.menuId}}", name: "leak", type: "directory" }, note: "create a menu under another tenant's menu" },
];

/** 不接收别人的 id、只作用于调用者自己租户的写接口。 */
export const OTHER_ROUTES: Record<string, string> = {
  "POST /api/auth/session": "registers the caller's own session; body has only an entry code",
  "POST /api/roles": "creates a role in the caller's tenant from name/code only",
  "POST /api/menus": "tested above with a foreign parent id; otherwise creates in the caller's tenant",
  "POST /api/campuses": "creates a campus and its root department in the caller's tenant from plain fields",
  "POST /api/posts": "creates a post from plain fields",
  "POST /api/dict-types": "creates a dictionary in the caller's tenant from plain fields",
  "POST /api/params": "creates a parameter in the caller's tenant from plain fields",
  "DELETE /api/operation-logs": "clears the caller's own tenant's operation log (row-level security limits it to the tenant)",
  "POST /api/accounts/reconcile": "compares the caller's own tenant with its own Keycloak realm",
};
