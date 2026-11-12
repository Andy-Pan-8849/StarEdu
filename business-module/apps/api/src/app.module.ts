import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
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
import { PersonsController } from "./hr/persons.controller";
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
import { OrgController } from "./org/org.controller";
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
  OrgController,
  RolesController,
  MenusController,
  EntriesController,
  DataScopeSetsController,
  AccountsController,
  OnlineController,
  LogsController,
  PersonsController,
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
    MailService,
    PlatformPrismaService,
    PlatformAuthzService,
    PlatformAuditService,
    TenantsService,
    JobsService,
    { provide: APP_GUARD, useClass: TenantTokenGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // 健康检查不属于任何租户，其余所有路由先按主机名确定租户
    consumer.apply(TenantResolverMiddleware).exclude("healthz").forRoutes("*");
  }
}
