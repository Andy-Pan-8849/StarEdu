// 事件出站箱：选课作废、班级取消、教务代选等要通知学生的事先写在这里，B9 的通知服务消费。
import { Injectable } from "@nestjs/common";
import { requireTenant } from "../tenancy/request-scope";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";

@Injectable()
export class OutboxService {
  constructor(private readonly tenantDb: TenantPrismaService) {}

  async emit(type: string, payload: Record<string, unknown>): Promise<void> {
    const tenant = requireTenant("write event");
    await this.tenantDb.db.outboxEvent.create({ data: { tenantId: tenant.tenantId, type, payload: payload as never } });
  }
}
