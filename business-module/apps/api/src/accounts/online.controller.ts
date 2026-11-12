// 在线用户与强退，以及登录日志、操作日志的查询。
//   强退：把会话 id 放进拒绝名单（令牌即使没过期，下一个请求就被拒），同时让 Keycloak 结束这个会话
//   （刷新令牌也失效）。只能强退本租户的会话（在线记录按租户前缀隔离）。
import { Controller, Delete, Get, NotFoundException, Param, Query } from "@nestjs/common";
import type { OnlineSession } from "../auth/session-store";
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
    private readonly tenantDb: TenantPrismaService,
  ) {}

  /**
   * 在线用户以 Keycloak 的会话为准（谁真的登录着，包括还没调过我们接口的）；
   * IP 等信息优先取 Keycloak，账号 id 按用户名对到业务库。Keycloak 暂时连不上时退回 Redis 里记录的在线状态。
   */
  private async merged(tenantId: string, code: string): Promise<OnlineSession[]> {
    const realm = realmName("tenant", code);
    try {
      const admin = await this.keycloak.client();
      const byId = new Map<string, OnlineSession>();
      for (const clientId of ["admin", "portal"]) {
        for (const s of await admin.clientSessions(realm, clientId)) {
          if (byId.has(s.id)) continue;
          byId.set(s.id, { sid: s.id, accountId: "", username: s.username, entry: clientId, ip: s.ipAddress, loginAt: new Date(s.start).toISOString(), lastSeen: new Date(s.lastAccess).toISOString() });
        }
      }
      const rows = [...byId.values()];
      const accounts = rows.length ? await this.tenantDb.db.account.findMany({ where: { username: { in: [...new Set(rows.map((r) => r.username))] } }, select: { id: true, username: true } }) : [];
      for (const r of rows) r.accountId = accounts.find((a) => a.username === r.username)?.id ?? "";
      return rows.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
    } catch {
      return this.sessions.list(tenantId); // Keycloak 暂时不可用
    }
  }

  @Get()
  @RequirePermissions(PERMS.onlineList)
  list(@Auth() auth: AuthContext) {
    return this.merged(auth.tenantId, requireTenant("list sessions").code);
  }

  @Delete(":sid")
  @RequirePermissions(PERMS.onlineForceLogout)
  async forceLogout(@Auth() auth: AuthContext, @Param("sid") sid: string) {
    const tenant = requireTenant("force logout");
    const session = (await this.sessions.get(tenant.tenantId, sid)) ?? (await this.merged(tenant.tenantId, tenant.code)).find((s) => s.sid === sid);
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
