// 平台账号的权限解析：账号 → 平台角色 → 平台入口下的菜单/按钮。与租户的权限互不相通。
//   - 内置"平台超级管理员"角色：平台入口下全部生效菜单的权限；
//   - 其他角色：勾选的菜单；
//   - 按权限版本号缓存（Redis 键 perm:v:platform）。
import { Injectable } from "@nestjs/common";
import { RedisService } from "../redis/redis.service";
import { MenuGraph, type GraphMenu } from "../rbac/menu-graph";
import { PlatformPrismaService } from "./platform-prisma.service";

export interface PlatformAuthz {
  accountId: string;
  username: string;
  status: string;
  isBuiltin: boolean;
  isSuper: boolean;
  roleIds: string[];
  perms: string[];
  menuIds: string[];
  version: number;
}

const VERSION_KEY = "perm:v:platform";

@Injectable()
export class PlatformAuthzService {
  constructor(
    private readonly db: PlatformPrismaService,
    private readonly redis: RedisService,
  ) {}

  async version(): Promise<number> {
    return Number((await this.redis.client.get(VERSION_KEY)) ?? 0);
  }
  bump(): Promise<number> {
    return this.redis.client.incr(VERSION_KEY);
  }

  /** 平台入口的菜单图：只含平台提供的菜单，平台不需要"功能授权"，所以全部视为已授权。 */
  async graph(): Promise<MenuGraph> {
    const menus = (await this.db.menu.findMany({ where: { tenantId: null, deletedAt: null } })) as GraphMenu[];
    const entries = new Map((await this.db.entry.findMany()).map((e) => [e.id, e.code]));
    const assignments = await this.db.entryMenu.findMany({ where: { tenantId: null } });
    return new MenuGraph(menus, new Set(menus.map((m) => m.id)), entries, assignments);
  }

  async load(accountId: string): Promise<PlatformAuthz | null> {
    const version = await this.version();
    const key = `pauthz:${accountId}`;
    const cached = await this.redis.client.get(key);
    if (cached) {
      const parsed = JSON.parse(cached) as PlatformAuthz | { missing: true; version: number };
      if (parsed.version === version) return "missing" in parsed ? null : parsed;
    }
    const fresh = await this.compute(accountId, version);
    await this.redis.client.set(key, JSON.stringify(fresh ?? { missing: true, version }), "EX", 3600);
    return fresh;
  }

  private async compute(accountId: string, version: number): Promise<PlatformAuthz | null> {
    const account = await this.db.platformAccount.findFirst({ where: { id: accountId, deletedAt: null } });
    if (!account) return null;
    const links = await this.db.platformAccountRole.findMany({ where: { accountId } });
    const roles = links.length ? await this.db.platformRole.findMany({ where: { id: { in: links.map((l) => l.roleId) }, deletedAt: null } }) : [];
    const graph = await this.graph();
    const roleMenus = roles.length ? await this.db.platformRoleMenu.findMany({ where: { roleId: { in: roles.map((r) => r.id) } } }) : [];
    const isSuper = roles.some((r) => r.kind === "super");
    const menuIds = new Set<string>();
    if (isSuper) graph.menusOfEntry("platform").forEach((m) => menuIds.add(m.id));
    for (const rm of roleMenus) if (graph.effective(rm.menuId)) menuIds.add(rm.menuId);
    const perms = [...menuIds].map((id) => graph.byId.get(id)?.perms).filter((p): p is string => !!p);
    return {
      accountId,
      username: account.username,
      status: account.status,
      isBuiltin: account.isBuiltin,
      isSuper,
      roleIds: roles.map((r) => r.id),
      perms: [...new Set(perms)].sort(),
      menuIds: [...menuIds],
      version,
    };
  }
}
