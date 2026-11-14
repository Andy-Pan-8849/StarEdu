// 租户配额检查（租户请求里用）：新增账号、申请上传前先看是否会超过平台设的上限。
// 上限存在租户表，应用账号读不了，所以走受限函数 biz.tenant_limits()（只返回当前租户的两个数）。
// 已有数据不删：降低上限后超出的部分保留，只是拒绝新增。
import { ConflictException, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { accountsWouldExceed, storageWouldExceed, type QuotaLimits } from "@staredu/shared";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { requireTenant } from "../tenancy/request-scope";

@Injectable()
export class QuotaService {
  constructor(private readonly tenantDb: TenantPrismaService) {}

  async limits(): Promise<QuotaLimits> {
    requireTenant("read quota");
    // 原生查询不会自动带租户会话变量，所以放进事务里设置后再查
    const rows = await this.tenantDb.transaction((tx) => tx.$queryRaw<{ max_accounts: number | null; max_storage_mb: number | null }[]>`SELECT * FROM biz.tenant_limits()`);
    return { maxAccounts: rows[0]?.max_accounts ?? null, maxStorageMb: rows[0]?.max_storage_mb ?? null };
  }

  /** 新增 `add` 个账号前调用；超限抛 409。服务账号不占名额。 */
  async assertCanAddAccounts(add = 1): Promise<void> {
    const { maxAccounts } = await this.limits();
    if (maxAccounts === null) return;
    const used = await this.tenantDb.db.account.count({ where: { deletedAt: null, isService: false } });
    if (accountsWouldExceed(used, maxAccounts, add)) throw new ConflictException(`Account quota reached (${used} of ${maxAccounts}); ask the platform administrator to raise the limit`);
  }

  /** 已用存储字节：文档库未删除的文件 + 已提交的作业文件。 */
  async storageUsedBytes(): Promise<number> {
    const db = this.tenantDb.db;
    const [lib, sub] = await Promise.all([
      db.docFile.aggregate({ _sum: { size: true }, where: { deletedAt: null } }),
      db.submissionFile.aggregate({ _sum: { size: true }, where: { versionId: { not: null } } }),
    ]);
    return (lib._sum.size ?? 0) + (sub._sum.size ?? 0);
  }

  /** 申请上传 `bytes` 字节前调用；超限抛 413。 */
  async assertCanStore(bytes: number): Promise<void> {
    const { maxStorageMb } = await this.limits();
    if (maxStorageMb === null) return;
    const used = await this.storageUsedBytes();
    if (storageWouldExceed(used, maxStorageMb, bytes)) {
      throw new HttpException(`Storage quota exceeded (${Math.round(used / 1024 / 1024)} MB of ${maxStorageMb} MB used); ask the platform administrator to raise the limit`, HttpStatus.PAYLOAD_TOO_LARGE);
    }
  }
}
