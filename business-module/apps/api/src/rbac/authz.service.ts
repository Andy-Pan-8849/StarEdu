// 权限解析：账号 → 角色 → 菜单与按钮上的权限字符。
//   - 普通角色：角色勾选的菜单/按钮，且必须是本租户已开通（功能授权）、启用的；
//   - 内置"租户管理员"：本租户已开通的、分配给"管理后台"入口的全部操作权限（不用通配符）；
//   - 内置"学生"：已开通的、分配给"学生门户"入口的全部权限。
// 结果按"权限版本号"缓存（每个租户一个计数器，在 Redis）：改角色/菜单/数据权限集/角色分配时加一，
// 请求时发现版本不一致就重新加载。
import { Injectable } from "@nestjs/common";
import { RedisService } from "../redis/redis.service";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { MenuGraph, type GraphMenu } from "./menu-graph";

export interface AuthzRole {
  id: string;
  code: string;
  kind: "custom" | "tenant_admin" | "student";
  perms: string[];
  /** 角色勾选且生效的菜单/按钮 id（内置管理员 = 管理后台入口下全部生效的菜单；学生 = 学生门户全部） */
  menuIds: string[];
}

export interface Authz {
  accountId: string;
  username: string;
  status: "pending" | "active" | "locked" | "disabled";
  isBuiltinAdmin: boolean;
  personId: string | null;
  roles: AuthzRole[];
  /** 所有角色的权限字符并集 */
  perms: string[];
  version: number;
}

const CACHE_TTL_SECONDS = 3600;

@Injectable()
export class AuthzService {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly redis: RedisService,
  ) {}

  private versionKey(tenantId: string): string {
    return `perm:v:${tenantId}`;
  }

  async version(tenantId: string): Promise<number> {
    return Number((await this.redis.client.get(this.versionKey(tenantId))) ?? 0);
  }

  /** 权限相关的数据变了就调用：该租户所有人的缓存立即作废。 */
  async bump(tenantId: string): Promise<number> {
    return this.redis.client.incr(this.versionKey(tenantId));
  }

  private roleView(
    r: { id: string; code: string; kind: AuthzRole["kind"] },
    graph: MenuGraph,
    roleMenus: Array<{ roleId: string; menuId: string }>,
  ): AuthzRole {
    let menuIds: string[];
    if (r.kind === "tenant_admin") menuIds = graph.menusOfEntry("admin").map((m) => m.id);
    else if (r.kind === "student") menuIds = graph.menusOfEntry("portal").map((m) => m.id);
    else menuIds = roleMenus.filter((rm) => rm.roleId === r.id && graph.effective(rm.menuId)).map((rm) => rm.menuId);
    const perms = menuIds.map((id) => graph.byId.get(id)?.perms).filter((p): p is string => !!p);
    return { id: r.id, code: r.code, kind: r.kind, perms: [...new Set(perms)].sort(), menuIds: [...new Set(menuIds)] };
  }

  /** 一组角色各自的权限（防提权校验用）。必须在租户上下文里调用。 */
  async rolesView(roleIds: string[]): Promise<AuthzRole[]> {
    if (roleIds.length === 0) return [];
    const db = this.tenantDb.db;
    const roles = await db.role.findMany({ where: { id: { in: roleIds } } });
    const roleMenus = await db.roleMenu.findMany({ where: { roleId: { in: roleIds } } });
    const graph = await this.graph();
    return roles.map((r) => this.roleView(r, graph, roleMenus));
  }

  /** 当前租户的菜单图（平台提供 + 本租户自建，加功能授权和入口分配）。 */
  async graph(): Promise<MenuGraph> {
    const db = this.tenantDb.db;
    const menus = (await db.menu.findMany({})) as GraphMenu[];
    const granted = new Set((await db.tenantMenuGrant.findMany({})).map((g) => g.menuId));
    const entries = new Map((await db.entry.findMany()).map((e) => [e.id, e.code]));
    const assignments = await db.entryMenu.findMany({});
    return new MenuGraph(menus, granted, entries, assignments);
  }

  /** 加载账号的权限；账号不存在（或已软删除）返回 null。必须在请求的租户上下文里调用。 */
  async load(tenantId: string, accountId: string): Promise<Authz | null> {
    const version = await this.version(tenantId);
    const cacheKey = `authz:${tenantId}:${accountId}`;
    const cached = await this.redis.client.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as Authz | { missing: true; version: number };
      if (parsed.version === version) return "missing" in parsed ? null : parsed;
    }
    const fresh = await this.compute(accountId, version);
    await this.redis.client.set(cacheKey, JSON.stringify(fresh ?? { missing: true, version }), "EX", CACHE_TTL_SECONDS);
    return fresh;
  }

  private async compute(accountId: string, version: number): Promise<Authz | null> {
    const db = this.tenantDb.db;
    const account = await db.account.findUnique({ where: { id: accountId } });
    if (!account) return null;

    const links = await db.accountRole.findMany({ where: { accountId } });
    const roles = links.length ? await db.role.findMany({ where: { id: { in: links.map((l) => l.roleId) } } }) : [];

    const graph = await this.graph();
    const roleMenus = roles.length ? await db.roleMenu.findMany({ where: { roleId: { in: roles.map((r) => r.id) } } }) : [];
    const authzRoles: AuthzRole[] = roles.map((r) => this.roleView(r, graph, roleMenus));
    return {
      accountId: account.id,
      username: account.username,
      status: account.status,
      isBuiltinAdmin: account.isBuiltinAdmin,
      personId: account.personId,
      roles: authzRoles,
      perms: [...new Set(authzRoles.flatMap((r) => r.perms))].sort(),
      version,
    };
  }
}
