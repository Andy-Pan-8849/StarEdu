import { Controller, Delete, Get, Query } from "@nestjs/common";
import { PERMS } from "@staredu/shared";
import { AuditService } from "../audit/audit.service";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, paging } from "../common/http";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";

@Controller("api/operation-logs")
export class OperationLogController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions(PERMS.operationLogList)
  list(@Query() query: { page?: string; size?: string; username?: string; method?: string; status?: string }) {
    const status = Number.parseInt(query.status ?? "", 10);
    const where = {
      ...(query.username ? { username: { contains: query.username, mode: "insensitive" as const } } : {}),
      ...(query.method ? { method: query.method.toUpperCase() } : {}),
      ...(Number.isFinite(status) ? { status } : {}),
    };
    return this.tenantDb.db.operationLog.findMany({ where, orderBy: { createdAt: "desc" }, ...paging(query) });
  }

  /** 清空是危险操作：单独权限码，并且清空这件事本身写进审计日志（审计日志不能被清空）。 */
  @Delete()
  @RequirePermissions(PERMS.operationLogClear)
  async clear(@Auth() auth: AuthContext) {
    const { count } = await this.tenantDb.db.operationLog.deleteMany({});
    await this.audit.record(auth.accountId, "operationLog.clear", "operationLog", null, { deleted: count });
    return { deleted: count };
  }
}
