// 操作日志：权限变更、角色分配、强退等敏感写操作。写在请求的租户上下文里。
import { Injectable } from "@nestjs/common";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { requireTenant } from "../tenancy/request-scope";

@Injectable()
export class AuditService {
  constructor(private readonly tenantDb: TenantPrismaService) {}

  async record(
    actorAccountId: string | null,
    action: string,
    targetType: string,
    targetId: string | null,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    requireTenant("write audit log");
    await this.tenantDb.db.auditLog.create({
      // tenantId 由租户客户端自动补上
      data: { actorAccountId, action, targetType, targetId, detail: (detail ?? undefined) as never } as never,
    });
  }
}
