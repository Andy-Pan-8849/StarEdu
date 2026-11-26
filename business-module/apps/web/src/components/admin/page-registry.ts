// 页面组件注册表：菜单的"组件路径" → 构建时打包的页面。租户不能新增页面组件（11 号文档 4D）。
// 还没有页面的菜单，外壳显示"页面尚未提供"。新里程碑的页面在这里登记。
import type * as React from "react";
import { JobsPage, MonitorPage, PlatformAuditPage, TenantsPage } from "./pages/platform-pages";
import { CoursesPage, MajorsPage, PortalEnrollPage, PortalPlanPage, SectionsPage, TermsPage } from "./pages/edu-pages";
import { PortalCoursesPage } from "./pages/course-pages";
import { PortalAssignmentsPage } from "./pages/assignment-pages";
import { DashboardPage, GradingScalePage, PortalGradesPage, TranscriptsPage } from "./pages/grade-pages";
import { PortalRequestsPage, RequestsPage } from "./pages/request-pages";
import { AnnouncementsPage } from "./pages/announcement-pages";
import { PortalDiscussionsPage } from "./pages/discussion-pages";
import { LibraryPage, PortalLibraryPage } from "./pages/library-pages";
import { PeoplePage, StaffPage, StudentsPage } from "./pages/hr-pages";
import { DataScopesPage, EntriesPage, MenusPage, RolesPage, UsersPage } from "./pages/access-pages";
import { CampusesPage, DeptsPage, DictsPage, OperationLogPage, ParamsPage, PostsPage } from "./pages/system-pages";
import { PlatformAccountsPage, PlatformAnnouncementsPage, PlatformEntriesPage, PlatformMenusPage, PlatformRolesPage } from "./pages/platform-console-pages";
import { AuditLogPage, LoginLogPage, OnlineUsersPage } from "./pages/log-pages";

export const PAGES: Record<string, React.ComponentType> = {
  "edu/term/index": TermsPage,
  "edu/major/index": MajorsPage,
  "edu/course/index": CoursesPage,
  "edu/section/index": SectionsPage,
  "portal/course/index": PortalCoursesPage,
  "portal/enroll/index": PortalEnrollPage,
  "portal/plan/index": PortalPlanPage,
  "portal/assignment/index": PortalAssignmentsPage,
  "portal/grade/index": PortalGradesPage,
  "portal/discussion/index": PortalDiscussionsPage,
  "doc/library/index": LibraryPage,
  "portal/library/index": PortalLibraryPage,
  "msg/announcement/index": AnnouncementsPage,
  "edu/request/index": RequestsPage,
  "portal/request/index": PortalRequestsPage,
  "edu/scale/index": GradingScalePage,
  "edu/transcript/index": TranscriptsPage,
  "edu/dashboard/index": DashboardPage,
  "hr/person/index": PeoplePage,
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
  "platform/account/index": PlatformAccountsPage,
  "platform/role/index": PlatformRolesPage,
  "platform/menu/index": PlatformMenusPage,
  "platform/entry/index": PlatformEntriesPage,
  "platform/announcement/index": PlatformAnnouncementsPage,
  "platform/job/index": JobsPage,
  "platform/monitor/index": MonitorPage,
  "platform/log/index": PlatformAuditPage,
};
