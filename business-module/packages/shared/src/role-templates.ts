// 平台预置的角色模板：开通租户时复制给租户，租户可微调。
// 内置的"租户管理员"和"学生"不在这里（它们是内置角色，由开通流程直接创建，租户不能改删）。
// scopes 是内置数据权限集的 code（all / own_dept / own_dept_tree / self / own_classes）。
// menuCodes 引用 MENU_CATALOG 的 code；后续里程碑新增功能时在这里补。
export interface RoleTemplate {
  code: string;
  name: string;
  sort: number;
  scopes: string[];
  menuCodes: string[];
}

export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    code: "hr-manager",
    name: "HR manager",
    sort: 10,
    scopes: ["all"],
    menuCodes: [
      "hr", "hr:person", "hr:person:edit", "hr:person:sensitive", "hr:person:emergencyView", "hr:person:emergencyEdit",
      "hr:staff", "hr:staff:add", "hr:staff:edit", "hr:staff:assign", "hr:staff:end", "hr:staff:import",
      "hr:student", "hr:student:add", "hr:student:edit", "hr:student:import",
    ],
  },
  {
    code: "academic-manager",
    name: "Academic manager",
    sort: 20,
    scopes: ["all"],
    menuCodes: [
      "edu", "edu:term", "edu:term:add", "edu:term:edit", "edu:major", "edu:major:add", "edu:major:edit", "edu:course", "edu:course:add", "edu:course:edit",
      "edu:section", "edu:section:add", "edu:section:edit", "edu:section:status", "edu:section:roster", "edu:section:enroll", "edu:section:unenroll", "edu:section:materials",
      "hr", "hr:student",
    ],
  },
  { code: "campus-lead", name: "Campus lead", sort: 30, scopes: ["own_dept_tree"], menuCodes: ["hr", "hr:person", "hr:staff", "hr:student"] },
  { code: "teacher", name: "Teacher", sort: 40, scopes: ["self", "own_classes"], menuCodes: ["edu", "edu:term", "edu:course", "edu:section", "edu:section:roster", "edu:section:materials"] },
];

export const BUILTIN_SCOPE_CODES = ["all", "own_dept", "own_dept_tree", "self", "own_classes"] as const;
