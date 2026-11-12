import { Injectable } from "@nestjs/common";
import { PlatformPrismaService } from "./platform-prisma.service";

@Injectable()
export class PlatformAuditService {
  constructor(private readonly db: PlatformPrismaService) {}

  async record(actorAccountId: string | null, action: string, targetType: string, targetId: string | null, detail?: Record<string, unknown>): Promise<void> {
    await this.db.platformAuditLog.create({ data: { actorAccountId, action, targetType, targetId, detail: (detail ?? undefined) as never } });
  }
}
