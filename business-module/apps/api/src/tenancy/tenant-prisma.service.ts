import { Injectable } from "@nestjs/common";
import { Prisma } from "../generated/prisma";
import { PrismaService } from "../prisma/prisma.service";
import { currentScope, TenantContextMissingError, requireTenant } from "./request-scope";
import { filterSoftDeleted, scopeArgs, TENANT_MODELS } from "./scope-args";


/** 事务里的客户端：只改写参数；租户会话变量已经在事务开头设好。 */
function scopeOnly() {
  return Prisma.defineExtension({
    name: "tenant-scope-in-transaction",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const tenantId = TENANT_MODELS[model] ? requireTenant(`${operation} ${model}`).tenantId : null;
          const rewritten = tenantId ? scopeArgs(model, operation, args as never, tenantId) : args;
          return filterSoftDeleted(model, operation, await query(rewritten as never));
        },
      },
    },
  });
}

/**
 * 租户感知的数据库访问：
 *  1. 每个操作的参数自动带上 tenant_id（读写都是），不传租户条件也只能碰本租户；
 *  2. 每个操作在同一个事务里先 set_config('app.tenant_id')，让数据库的行级安全生效
 *     （连接池下必须用事务级设置，否则会话变量会漏给下一个请求）；
 *  3. 没有租户上下文就直接报错，不放行。
 * 原生 SQL（$queryRaw）不经过第 1 层，但仍受第 2、3 层约束：没设置租户 = 查不到行。
 */
@Injectable()
export class TenantPrismaService {
  readonly db: ReturnType<TenantPrismaService["build"]>;
  /** 只改写参数的客户端：事务里使用，租户会话变量在事务开头设一次 */
  private readonly txBase;

  constructor(private readonly base: PrismaService) {
    this.db = this.build(base);
    this.txBase = base.$extends(scopeOnly());
  }

  private build(base: PrismaService) {
    return base.$extends({
      name: "tenant-scope",
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            const scope = currentScope();
            if (!TENANT_MODELS[model] && model !== "Tenant") {
              return query(args); // 入口等全局只读表
            }
            if (!scope || scope.kind !== "tenant") {
              throw new TenantContextMissingError(`${operation} ${model}`);
            }
            const rewritten = TENANT_MODELS[model] ? scopeArgs(model, operation, args as never, scope.tenantId) : args;
            const [, result] = await base.$transaction([
              base.$executeRaw`SELECT set_config('app.tenant_id', ${scope.tenantId}, true)`,
              query(rewritten as never) as never,
            ]);
            return filterSoftDeleted(model, operation, result);
          },
        },
      },
    });
  }

  /**
   * 需要多步原子操作时用：事务内所有操作共用同一个租户设置，参数同样自动带上租户。
   * 注意：必须 await 在请求的调用链里（Prisma 的查询是惰性的，到 await 时才执行，
   * 那时才读取当前租户）。
   */
  async transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const scope = requireTenant("start a transaction");
    return this.txBase.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${scope.tenantId}, true)`;
      return fn(tx as unknown as Prisma.TransactionClient);
    });
  }
}
