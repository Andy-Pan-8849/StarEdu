// 页面组件注册表：菜单的"组件路径" → 构建时打包的页面。租户不能新增页面组件（11 号文档 4D）。
// 还没有页面的菜单，外壳显示"页面尚未提供"。新里程碑的页面在这里登记。
import type * as React from "react";
import { JobsPage, MonitorPage, PlatformAuditPage, TenantsPage } from "./pages/platform-pages";
import { AuditLogPage, LoginLogPage, OnlineUsersPage } from "./pages/log-pages";

export const PAGES: Record<string, React.ComponentType> = {
  "system/online/index": OnlineUsersPage,
  "system/loginLog/index": LoginLogPage,
  "system/auditLog/index": AuditLogPage,
  "platform/tenant/index": TenantsPage,
  "platform/job/index": JobsPage,
  "platform/monitor/index": MonitorPage,
  "platform/log/index": PlatformAuditPage,
};
