// 操作日志：权限变更、角色分配、强退等敏感写操作。写在请求的租户上下文里。
import { Injectable } from "@nestjs/common";
import { extendedEvents } from "../events/event-bus";
import { OutboxService } from "../edu/outbox.service";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { requireTenant } from "../tenancy/request-scope";

@Injectable()
export class AuditService {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly outbox: OutboxService,
  ) {}

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
    // kafka 模式：同一条记录再作为事件发出去（只带动作和对象 id，不带明细）；账号相关的动作另发"账号变更"
    if (extendedEvents()) {
      await this.outbox.emit("audit.recorded", { action, targetType, targetId, actorAccountId });
      if (action.startsWith("account.") && targetId) await this.outbox.emit("account.changed", { accountId: targetId, change: action, actorAccountId });
    }
  }
}
