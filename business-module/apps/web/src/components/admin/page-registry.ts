// 页面组件注册表：菜单的"组件路径" → 构建时打包的页面。租户不能新增页面组件（11 号文档 4D）。
// 还没有页面的菜单，外壳显示"页面尚未提供"。新里程碑的页面在这里登记。
import type * as React from "react";
import { JobsPage, MonitorPage, PlatformAuditPage, TenantsPage } from "./pages/platform-pages";
import { CoursesPage, MajorsPage, PortalEnrollPage, PortalPlanPage, SectionsPage, TermsPage } from "./pages/edu-pages";
import { StaffPage, StudentsPage } from "./pages/hr-pages";
import { DataScopesPage, EntriesPage, MenusPage, RolesPage, UsersPage } from "./pages/access-pages";
import { CampusesPage, DeptsPage, DictsPage, OperationLogPage, ParamsPage, PostsPage } from "./pages/system-pages";
import { AuditLogPage, LoginLogPage, OnlineUsersPage } from "./pages/log-pages";

export const PAGES: Record<string, React.ComponentType> = {
  "edu/term/index": TermsPage,
  "edu/major/index": MajorsPage,
  "edu/course/index": CoursesPage,
  "edu/section/index": SectionsPage,
  "portal/enroll/index": PortalEnrollPage,
  "portal/plan/index": PortalPlanPage,
  "hr/staff/index": StaffPage,
  "hr/student/index": StudentsPage,
  "system/user/index": UsersPage,
  "system/role/index": RolesPage,
  "system/menu/index": MenusPage,
  "system/entry/index": EntriesPage,
  "system/dataScope/index": DataScopesPage,
  "system/campus/index": CampusesPage,
  "system/dept/index": DeptsPage,
  "system/post/index": PostsPage,
  "system/dict/index": DictsPage,
  "system/param/index": ParamsPage,
  "system/operationLog/index": OperationLogPage,
  "system/online/index": OnlineUsersPage,
  "system/loginLog/index": LoginLogPage,
  "system/auditLog/index": AuditLogPage,
  "platform/tenant/index": TenantsPage,
  "platform/job/index": JobsPage,
  "platform/monitor/index": MonitorPage,
  "platform/log/index": PlatformAuditPage,
};
