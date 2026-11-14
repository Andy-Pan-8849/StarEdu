// 租户使用情况与配额（平台入口）：账号数、存储、文件数，和平台设的上限。
// 用库所有者的连接（绕过行级安全）按租户汇总；上限改动写平台审计日志。
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { BYTES_PER_MB, meter, quotaProblems, type QuotaLimits } from "@staredu/shared";
import { PlatformAuditService } from "./platform-audit.service";
import { PlatformPrismaService } from "./platform-prisma.service";

interface Usage {
  accounts: number;
  activeAccounts: number;
  libraryFiles: number;
  libraryBytes: number;
  submissionFiles: number;
  submissionBytes: number;
}

const empty = (): Usage => ({ accounts: 0, activeAccounts: 0, libraryFiles: 0, libraryBytes: 0, submissionFiles: 0, submissionBytes: 0 });

@Injectable()
export class TenantUsageService {
  constructor(private readonly db: PlatformPrismaService, private readonly audit: PlatformAuditService) {}

  /** 每个租户的用量；传了 id 只算这一个。 */
  private async usage(tenantId?: string): Promise<Map<string, Usage>> {
    const where = tenantId ? { tenantId } : {};
    const [accounts, files, subs] = await Promise.all([
      this.db.account.groupBy({ by: ["tenantId", "status"], where: { ...where, deletedAt: null, isService: false }, _count: { _all: true } }),
      this.db.docFile.groupBy({ by: ["tenantId"], where: { ...where, deletedAt: null }, _count: { _all: true }, _sum: { size: true } }),
      this.db.submissionFile.groupBy({ by: ["tenantId"], where: { ...where, versionId: { not: null } }, _count: { _all: true }, _sum: { size: true } }),
    ]);
    const out = new Map<string, Usage>();
    const of = (id: string) => out.get(id) ?? out.set(id, empty()).get(id)!;
    for (const a of accounts) {
      const u = of(a.tenantId);
      u.accounts += a._count._all;
      if (a.status === "active") u.activeAccounts += a._count._all;
    }
    for (const f of files) Object.assign(of(f.tenantId), { libraryFiles: f._count._all, libraryBytes: f._sum.size ?? 0 });
    for (const s of subs) Object.assign(of(s.tenantId), { submissionFiles: s._count._all, submissionBytes: s._sum.size ?? 0 });
    return out;
  }

  private view(t: { id: string; code: string; name: string; status: string; maxAccounts: number | null; maxStorageMb: number | null }, u: Usage) {
    const storageBytes = u.libraryBytes + u.submissionBytes;
    return {
      tenantId: t.id,
      code: t.code,
      name: t.name,
      status: t.status,
      limits: { maxAccounts: t.maxAccounts, maxStorageMb: t.maxStorageMb } satisfies QuotaLimits,
      usage: { ...u, storageBytes, storageMb: Math.round((storageBytes / BYTES_PER_MB) * 10) / 10 },
      accountsMeter: meter(u.accounts, t.maxAccounts),
      storageMeter: meter(Math.ceil(storageBytes / BYTES_PER_MB), t.maxStorageMb),
    };
  }

  async list() {
    const [tenants, usage] = await Promise.all([this.db.tenant.findMany({ orderBy: { createdAt: "asc" } }), this.usage()]);
    return tenants.map((t) => this.view(t, usage.get(t.id) ?? empty()));
  }

  async get(id: string) {
    const t = await this.db.tenant.findUnique({ where: { id } });
    if (!t) throw new NotFoundException();
    return this.view(t, (await this.usage(id)).get(id) ?? empty());
  }

  async setLimits(actorId: string, id: string, limits: QuotaLimits) {
    const t = await this.db.tenant.findUnique({ where: { id } });
    if (!t) throw new NotFoundException();
    const problems = quotaProblems(limits);
    if (problems.length) throw new BadRequestException(problems.join("; "));
    await this.db.tenant.update({ where: { id }, data: { maxAccounts: limits.maxAccounts, maxStorageMb: limits.maxStorageMb } });
    await this.audit.record(actorId, "tenant.quota", "tenant", id, { before: { maxAccounts: t.maxAccounts, maxStorageMb: t.maxStorageMb }, after: limits });
    return this.get(id);
  }
}
