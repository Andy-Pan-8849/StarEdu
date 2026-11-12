// 在线用户与强退，以及登录日志、操作日志的查询。
//   强退：把会话 id 放进拒绝名单（令牌即使没过期，下一个请求就被拒），同时让 Keycloak 结束这个会话
//   （刷新令牌也失效）。只能强退本租户的会话（在线记录按租户前缀隔离）。
import { Controller, Delete, Get, NotFoundException, Param, Query } from "@nestjs/common";
import { PERMS, realmName } from "@staredu/shared";
import { AuditService } from "../audit/audit.service";
import { RequirePermissions } from "../auth/decorators";
import { SessionStore } from "../auth/session-store";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, paging } from "../common/http";
import { KeycloakService } from "../keycloak/keycloak.service";
import { requireTenant } from "../tenancy/request-scope";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";

@Controller("api/online")
export class OnlineController {
  constructor(
    private readonly sessions: SessionStore,
    private readonly keycloak: KeycloakService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions(PERMS.onlineList)
  list(@Auth() auth: AuthContext) {
    return this.sessions.list(auth.tenantId);
  }

  @Delete(":sid")
  @RequirePermissions(PERMS.onlineForceLogout)
  async forceLogout(@Auth() auth: AuthContext, @Param("sid") sid: string) {
    const tenant = requireTenant("force logout");
    const session = await this.sessions.get(tenant.tenantId, sid);
    if (!session) throw new NotFoundException();
    const realm = realmName("tenant", tenant.code);
    await this.sessions.deny(realm, sid);
    await this.sessions.remove(tenant.tenantId, sid);
    let keycloakEnded = true;
    try {
      await (await this.keycloak.client()).deleteSession(realm, sid);
    } catch {
      keycloakEnded = false; // 拒绝名单已经让访问令牌失效；刷新令牌随会话过期
    }
    await this.audit.record(auth.accountId, "session.forceLogout", "session", sid, { accountId: session.accountId, username: session.username, keycloakEnded });
    return { sid, keycloakEnded };
  }
}

@Controller("api")
export class LogsController {
  constructor(private readonly tenantDb: TenantPrismaService) {}

  @Get("login-logs")
  @RequirePermissions(PERMS.loginLogList)
  loginLogs(@Query() query: { page?: string; size?: string }) {
    return this.tenantDb.db.loginLog.findMany({ orderBy: { createdAt: "desc" }, ...paging(query) });
  }

  @Get("audit-logs")
  @RequirePermissions(PERMS.auditLogList)
  auditLogs(@Query() query: { page?: string; size?: string }) {
    return this.tenantDb.db.auditLog.findMany({ orderBy: { createdAt: "desc" }, ...paging(query) });
  }
}
