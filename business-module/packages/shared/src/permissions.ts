// 权限码（权限字符）：格式 `模块:资源:动作`。后端 @RequirePermissions 和前端按钮显示用同一份常量。
// 隐藏按钮只是方便，接口每次都校验。
export const PERMS = {
  // 系统管理
  userList: "system:user:list",
  userAdd: "system:user:add",
  userEdit: "system:user:edit",
  userAssignRole: "system:user:assignRole",
  userReconcile: "system:user:reconcile",
  roleList: "system:role:list",
  roleAdd: "system:role:add",
  roleEdit: "system:role:edit",
  roleRemove: "system:role:remove",
  roleAuthorize: "system:role:authorize",
  menuList: "system:menu:list",
  menuAdd: "system:menu:add",
  menuEdit: "system:menu:edit",
  menuRemove: "system:menu:remove",
  entryList: "system:entry:list",
  entryEdit: "system:entry:edit",
  dataScopeList: "system:dataScope:list",
  dataScopeAdd: "system:dataScope:add",
  dataScopeEdit: "system:dataScope:edit",
  dataScopeRemove: "system:dataScope:remove",
  deptList: "system:dept:list",
  campusList: "system:campus:list",
  postList: "system:post:list",
  onlineList: "system:online:list",
  onlineForceLogout: "system:online:forceLogout",
  loginLogList: "system:loginLog:list",
  auditLogList: "system:auditLog:list",
  // 人事
  hrPersonList: "hr:person:list",
  hrPersonEdit: "hr:person:edit",
} as const;

export type Permission = (typeof PERMS)[keyof typeof PERMS];

export const PERMISSION_PATTERN = /^[a-z][a-zA-Z0-9]*:[a-z][a-zA-Z0-9]*:[a-z][a-zA-Z0-9]*$/;
