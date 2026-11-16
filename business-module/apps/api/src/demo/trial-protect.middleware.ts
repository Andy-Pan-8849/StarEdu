// 公开试用站的保护（规则在 trial-protect.ts）：放在租户识别之后，所以知道请求属于哪家公司。
import { ForbiddenException, Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { currentScope } from "../tenancy/request-scope";
import { isTrialBlocked, TRIAL_RESTRICTED_MESSAGE, trialProtectEnabled } from "./trial-protect";

@Injectable()
export class TrialProtectMiddleware implements NestMiddleware {
  constructor(private readonly prisma: PrismaService) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    if (!trialProtectEnabled()) return next();
    const scope = currentScope();
    if (!scope) return next();
    if (!isTrialBlocked(scope.kind, req.method, (req.originalUrl ?? req.url).split("?")[0])) return next();
    if (scope.kind === "tenant") {
      const rows = await this.prisma.$queryRaw<Array<{ is_demo: boolean }>>`SELECT biz.is_demo_tenant(${scope.tenantId}::uuid) AS is_demo`;
      if (!rows[0]?.is_demo) return next(); // 真实公司不受影响
    }
    throw new ForbiddenException({ statusCode: 403, code: "trial_restricted", message: TRIAL_RESTRICTED_MESSAGE });
  }
}
