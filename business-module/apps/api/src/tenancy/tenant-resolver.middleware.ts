import { ForbiddenException, Injectable, NestMiddleware, NotFoundException } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { isPlatformHost, runInScope, tenantCodeFromHost } from "./request-scope";

interface ResolvedTenant {
  id: string;
  code: string;
  name: string;
  status: string;
}

/** 按访问的主机名确定租户；不信任请求头里任何自带的租户 ID。 */
@Injectable()
export class TenantResolverMiddleware implements NestMiddleware {
  constructor(private readonly prisma: PrismaService) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const host = req.headers.host;
    if (isPlatformHost(host)) {
      runInScope({ kind: "platform" }, () => next());
      return;
    }
    const code = tenantCodeFromHost(host);
    if (!code) throw new NotFoundException("Unknown tenant");
    // 租户表对应用账号只开放"自己"，识别发生在知道"自己是谁"之前，所以走受限函数
    const rows = await this.prisma.$queryRaw<ResolvedTenant[]>`SELECT * FROM biz.resolve_tenant(${code})`;
    const tenant = rows[0];
    if (!tenant) throw new NotFoundException("Unknown tenant");
    if (tenant.status !== "active" && tenant.status !== "notified") {
      throw new ForbiddenException("Tenant is not active");
    }
    runInScope(
      { kind: "tenant", tenantId: tenant.id, code: tenant.code, name: tenant.name, status: tenant.status },
      () => next(),
    );
  }
}
