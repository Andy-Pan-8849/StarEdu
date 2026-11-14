import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { AccountsController } from "./accounts/accounts.controller";
import { AccountsService } from "./accounts/accounts.service";
import { LogsController, OnlineController } from "./accounts/online.controller";
import { AuditService } from "./audit/audit.service";
import { SessionStore } from "./auth/session-store";
import { TenantTokenGuard } from "./auth/tenant-token.guard";
import { TokenVerifier } from "./auth/token-verifier";
import { DataScopeService } from "./data-scope/data-scope.service";
import { HealthController } from "./health/health.controller";
import { HealthService } from "./health/health.service";
import { OperationLogController } from "./oplog/operation-log.controller";
import { OperationLogInterceptor } from "./oplog/operation-log.interceptor";
import { DictController } from "./sysdata/dict.controller";
import { ParamsController } from "./sysdata/params.controller";
import { ImportController } from "./hr/import.controller";
import { ImportService } from "./hr/import.service";
import { CatalogController } from "./edu/catalog.controller";
import { ClassMembershipService } from "./edu/class-membership.service";
import { EnrollmentService } from "./edu/enrollment.service";
import { OutboxService } from "./edu/outbox.service";
import { PortalController } from "./edu/portal.controller";
import { SectionsController } from "./edu/sections.controller";
import { AnnouncementsController } from "./notify/announcements.controller";
import { BannersController, NotificationsController, UnsubscribeController } from "./notify/notifications.controller";
import { NotificationService } from "./notify/notification.service";
import { NotifyWorker } from "./notify/notify-worker";
import { PlatformAnnouncementsController } from "./notify/platform-announcements.controller";
import { RealtimeService } from "./notify/realtime.service";
import { DiscussionController, PortalDiscussionController } from "./edu/discussion.controller";
import { DiscussionService } from "./edu/discussion.service";
import { GradesController } from "./edu/grades.controller";
import { GradeAdminController } from "./edu/grade-admin.controller";
import { PortalGradesController } from "./edu/portal-grades.controller";
import { GradesService } from "./edu/grades.service";
import { TranscriptService } from "./edu/transcript.service";
import { AssignmentsController } from "./edu/assignments.controller";
import { PortalAssignmentsController } from "./edu/portal-assignments.controller";
import { ObjectStoreService } from "./storage/object-store.service";
import { CLASS_MEMBERSHIP } from "./data-scope/data-scope.service";
import { EmergencyController } from "./hr/emergency.controller";
import { HrAccess } from "./hr/hr-access.service";
import { PersonsController } from "./hr/persons.controller";
import { StaffController } from "./hr/staff.controller";
import { StaffService } from "./hr/staff.service";
import { StudentsController } from "./hr/students.controller";
import { KeycloakService } from "./keycloak/keycloak.service";
import { MailService } from "./mail/mail.service";
import { JobsService } from "./platform/jobs/jobs.service";
import { MonitorController } from "./platform/monitor.controller";
import { PlatformController } from "./platform/platform-accounts.controller";
import { PlatformAuditService } from "./platform/platform-audit.service";
import { PlatformAuthzService } from "./platform/platform-authz.service";
import { PlatformPrismaService } from "./platform/platform-prisma.service";
import { TenantsController } from "./platform/tenants.controller";
import { TenantsService } from "./platform/tenants.service";
import { MeController } from "./me/me.controller";
import { CampusesController } from "./org/campuses.controller";
import { DeptsController } from "./org/depts.controller";
import { PostsController } from "./org/posts.controller";
import { PrismaService } from "./prisma/prisma.service";
import { AuthzService } from "./rbac/authz.service";
import { DataScopeSetsController } from "./rbac/data-scope-sets.controller";
import { EntriesController, MenusController } from "./rbac/menus.controller";
import { RolesController } from "./rbac/roles.controller";
import { RedisService } from "./redis/redis.service";
import { TenantPrismaService } from "./tenancy/tenant-prisma.service";
import { TenantResolverMiddleware } from "./tenancy/tenant-resolver.middleware";

/** 全部控制器；泄露扫描的"路由都已登记"测试用同一份列表。 */
export const CONTROLLERS = [
  HealthController,
  MeController,
  CampusesController,
  DeptsController,
  PostsController,
  RolesController,
  MenusController,
  EntriesController,
  DataScopeSetsController,
  AccountsController,
  OnlineController,
  LogsController,
  PersonsController,
  StaffController,
  StudentsController,
  EmergencyController,
  ImportController,
  CatalogController,
  SectionsController,
  AssignmentsController,
  GradesController,
  DiscussionController,
  PortalDiscussionController,
  NotificationsController,
  BannersController,
  UnsubscribeController,
  AnnouncementsController,
  PlatformAnnouncementsController,
  GradeAdminController,
  PortalGradesController,
  PortalAssignmentsController,
  PortalController,
  DictController,
  ParamsController,
  OperationLogController,
  TenantsController,
  PlatformController,
  MonitorController,
];

@Module({
  controllers: CONTROLLERS,
  providers: [
    PrismaService,
    RedisService,
    HealthService,
    TenantPrismaService,
    TokenVerifier,
    SessionStore,
    AuthzService,
    DataScopeService,
    AuditService,
    KeycloakService,
    AccountsService,
    HrAccess,
    StaffService,
    ImportService,
    EnrollmentService,
    OutboxService,
    ObjectStoreService,
    GradesService,
    DiscussionService,
    NotificationService,
    NotifyWorker,
    RealtimeService,
    TranscriptService,
    { provide: CLASS_MEMBERSHIP, useClass: ClassMembershipService },
    MailService,
    PlatformPrismaService,
    PlatformAuthzService,
    PlatformAuditService,
    TenantsService,
    JobsService,
    { provide: APP_GUARD, useClass: TenantTokenGuard },
    { provide: APP_INTERCEPTOR, useClass: OperationLogInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // 健康检查不属于任何租户，其余所有路由先按主机名确定租户
    consumer.apply(TenantResolverMiddleware).exclude("healthz").forRoutes("*");
  }
}
