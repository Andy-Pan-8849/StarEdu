// 操作日志：每个已登录账号的写请求（POST/PUT/PATCH/DELETE）记一条——谁、哪个接口、结果状态、耗时、IP、脱敏后的请求参数；
// 返回内容不记。写日志失败不能影响业务请求。
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable, tap } from "rxjs";
import { OutboxService } from "../edu/outbox.service";
import { extendedEvents } from "../events/event-bus";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { sanitizeParams } from "./sanitize";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

@Injectable()
export class OperationLogInterceptor implements NestInterceptor {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly outbox: OutboxService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    if (!req.auth || !WRITE_METHODS.has(req.method)) return next.handle(); // 平台入口的请求没有租户上下文，记在平台操作日志里
    const started = Date.now();
    const write = (status: number, error?: string) => {
      const route: string = (req.route?.path as string | undefined) ?? req.path;
      void this.tenantDb.db.operationLog
        .create({
          data: {
            tenantId: req.auth.tenantId,
            accountId: req.auth.accountId,
            username: req.auth.authz.username,
            method: req.method,
            path: String(req.originalUrl ?? route).split("?")[0].slice(0, 300),
            status,
            durationMs: Date.now() - started,
            ip: req.ip ?? null,
            params: sanitizeParams({ body: req.body, query: req.query }) as never,
            error: error?.slice(0, 500) ?? null,
          } as never,
        })
        // kafka 模式：操作记录也作为事件发出去（方法、路径、状态；不带请求参数）
        .then(() => (extendedEvents() ? this.outbox.emit("audit.operation", { accountId: req.auth.accountId, method: req.method, path: String(req.originalUrl ?? route).split("?")[0].slice(0, 300), status }) : undefined))
        .catch(() => undefined);
    };
    return next.handle().pipe(
      tap({
        next: () => write(res.statusCode),
        error: (err: { getStatus?: () => number; message?: string }) => write(err.getStatus?.() ?? 500, err.message),
      }),
    );
  }
}
