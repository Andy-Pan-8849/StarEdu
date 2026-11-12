// 当前请求属于哪个租户（或是平台）。用 AsyncLocalStorage 在一次请求的调用链里传递，
// 不依赖前端传的任何租户 ID：租户只来自访问的主机名（11 号文档第 5 节）。
import { AsyncLocalStorage } from "node:async_hooks";

export interface TenantScope {
  kind: "tenant";
  tenantId: string;
  code: string;
  name: string;
  status: string;
}
export interface PlatformScope {
  kind: "platform";
}
export type RequestScope = TenantScope | PlatformScope;

const storage = new AsyncLocalStorage<RequestScope>();

export function runInScope<T>(scope: RequestScope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function currentScope(): RequestScope | undefined {
  return storage.getStore();
}

export class TenantContextMissingError extends Error {
  constructor(what: string) {
    super(`No tenant in context: refusing to ${what}`);
  }
}

/** 取当前租户；没有（或是平台域）就报错，宁可失败也不放行。 */
export function requireTenant(what = "access tenant data"): TenantScope {
  const scope = currentScope();
  if (!scope || scope.kind !== "tenant") throw new TenantContextMissingError(what);
  return scope;
}

/** 从 Host 头取租户代码：`hq.localhost:3001` → "hq"；平台域和 IP 地址返回 null。 */
export function tenantCodeFromHost(host: string | undefined): string | null {
  if (!host) return null;
  const name = host.split(":")[0].toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return null;
  const labels = name.split(".");
  if (labels.length < 2) return null; // "localhost" 这样的单段主机名没有租户
  return labels[0];
}

export function isPlatformHost(host: string | undefined): boolean {
  return (host ?? "").split(":")[0].toLowerCase().split(".")[0] === "platform";
}
