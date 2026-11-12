// 把"平台提供的菜单目录"和"角色模板"同步进数据库。可重复运行（幂等）：
//   - 菜单按 code 对账：新增的插入、改了的更新、目录里已删除的软删除；
//   - 顶层菜单到入口的平台分配（租户只读）同样对账；
//   - 角色模板的菜单勾选和数据权限集对账；已复制给租户的角色不动（租户可能微调过）。
// 用库所有者账号连库——这是平台操作，不属于任何租户的请求。
import { MENU_CATALOG, ROLE_TEMPLATES } from "@staredu/shared";
import type { PrismaClient } from "../generated/prisma";

export interface MenuSyncResult {
  created: number;
  updated: number;
  removed: number;
}

export async function syncPlatformMenus(owner: PrismaClient): Promise<MenuSyncResult> {
  const result: MenuSyncResult = { created: 0, updated: 0, removed: 0 };
  const existing = await owner.menu.findMany({ where: { tenantId: null, code: { not: null } } });
  const byCode = new Map(existing.map((m) => [m.code as string, m]));
  const idOf = new Map<string, string>();
  const createdCodes = new Set<string>();

  for (const item of MENU_CATALOG) {
    const parentId = item.parent ? (idOf.get(item.parent) ?? null) : null;
    const data = {
      parentId,
      nameKey: item.nameKey,
      name: item.name,
      type: item.type,
      route: item.route ?? null,
      component: item.component ?? null,
      perms: item.perms ?? null,
      icon: item.icon ?? null,
      sort: item.sort,
      deletedAt: null,
    };
    // 显示/启用由平台管理员在"菜单管理"里调整，同步只在新增时给默认值，不覆盖
    const defaults = { visible: true, status: true };
    const current = byCode.get(item.code);
    if (!current) {
      const row = await owner.menu.create({ data: { ...data, ...defaults, code: item.code, tenantId: null } });
      idOf.set(item.code, row.id);
      createdCodes.add(item.code);
      result.created += 1;
    } else {
      idOf.set(item.code, current.id);
      const changed = (Object.keys(data) as Array<keyof typeof data>).some((k) => current[k] !== data[k]);
      if (changed) {
        await owner.menu.update({ where: { id: current.id }, data });
        result.updated += 1;
      }
    }
  }
  const live = new Set(MENU_CATALOG.map((m) => m.code));
  for (const m of existing) {
    if (!live.has(m.code as string) && !m.deletedAt) {
      await owner.menu.update({ where: { id: m.id }, data: { deletedAt: new Date() } });
      result.removed += 1;
    }
  }

  // 顶层菜单 → 入口（平台分配，tenant_id 为空）。只给"这次新增的"菜单补默认分配；
  // 已有菜单的分配由平台管理员在"入口管理"里调整，同步不覆盖、不删除。
  const entries = new Map((await owner.entry.findMany()).map((e) => [e.code, e.id]));
  for (const item of MENU_CATALOG) {
    if (!createdCodes.has(item.code)) continue;
    for (const code of item.entries ?? []) {
      const entryId = entries.get(code);
      if (!entryId) throw new Error(`unknown entry "${code}" in menu catalog`);
      await owner.entryMenu.create({ data: { tenantId: null, entryId, menuId: idOf.get(item.code) as string, sort: item.sort } });
    }
  }
  return result;
}

export async function syncRoleTemplates(owner: PrismaClient): Promise<void> {
  const menus = new Map(
    (await owner.menu.findMany({ where: { tenantId: null, deletedAt: null, code: { not: null } }, select: { id: true, code: true } })).map(
      (m) => [m.code as string, m.id],
    ),
  );
  const sets = new Map(
    (await owner.dataScopeSet.findMany({ where: { tenantId: null }, select: { id: true, code: true } })).map((s) => [s.code, s.id]),
  );
  for (const t of ROLE_TEMPLATES) {
    let role = await owner.role.findFirst({ where: { tenantId: null, code: t.code } });
    if (!role) {
      role = await owner.role.create({ data: { tenantId: null, code: t.code, name: t.name, isTemplate: true, sort: t.sort } });
    } else if (role.name !== t.name || role.sort !== t.sort || role.deletedAt) {
      role = await owner.role.update({ where: { id: role.id }, data: { name: t.name, sort: t.sort, deletedAt: null } });
    }
    const wantMenus = t.menuCodes.map((c) => {
      const id = menus.get(c);
      if (!id) throw new Error(`role template ${t.code} references unknown menu ${c}`);
      return id;
    });
    const wantSets = t.scopes.map((c) => {
      const id = sets.get(c);
      if (!id) throw new Error(`role template ${t.code} references unknown data scope ${c}`);
      return id;
    });
    await owner.roleMenu.deleteMany({ where: { roleId: role.id, menuId: { notIn: wantMenus } } });
    await owner.roleMenu.createMany({ data: wantMenus.map((menuId) => ({ tenantId: null, roleId: role.id, menuId })), skipDuplicates: true });
    await owner.roleDataScope.deleteMany({ where: { roleId: role.id, setId: { notIn: wantSets } } });
    await owner.roleDataScope.createMany({ data: wantSets.map((setId) => ({ tenantId: null, roleId: role.id, setId })), skipDuplicates: true });
  }
}

/**
 * 可以授权给租户的平台菜单：顶层菜单分配给了"管理后台"或"学生门户"的；只分配给"平台"入口的不授权给租户。
 * 没有分配到任何入口的（草稿）也不授权。
 */
export async function grantablePlatformMenuIds(owner: PrismaClient): Promise<string[]> {
  const menus = await owner.menu.findMany({
    where: { tenantId: null, deletedAt: null, status: true },
    select: { id: true, parentId: true },
  });
  const parent = new Map(menus.map((m) => [m.id, m.parentId]));
  const assigned = await owner.entryMenu.findMany({ where: { tenantId: null }, include: { entry: true } });
  const tenantFacing = new Set(assigned.filter((a) => a.entry.code !== "platform").map((a) => a.menuId));
  const top = (id: string): string => {
    let cur = id;
    for (let guard = 0; guard < 50; guard += 1) {
      const p = parent.get(cur);
      if (!p) return cur;
      cur = p;
    }
    return cur;
  };
  return menus.filter((m) => tenantFacing.has(top(m.id))).map((m) => m.id);
}

/** 把还没有授权给租户的、可授权的平台菜单授权给它；返回新增数量。 */
export async function grantMissingMenus(owner: PrismaClient, tenantId: string): Promise<number> {
  const grantable = await grantablePlatformMenuIds(owner);
  const granted = new Set((await owner.tenantMenuGrant.findMany({ where: { tenantId }, select: { menuId: true } })).map((g) => g.menuId));
  const toGrant = grantable.filter((id) => !granted.has(id));
  if (toGrant.length > 0) await owner.tenantMenuGrant.createMany({ data: toGrant.map((menuId) => ({ tenantId, menuId })) });
  return toGrant.length;
}

/** 把租户还没有的角色模板复制过去（连同菜单勾选和数据权限集）；已经复制过的不动。返回步骤说明。 */
export async function copyMissingTemplates(owner: PrismaClient, tenantId: string): Promise<string[]> {
  const steps: string[] = [];
  const templates = await owner.role.findMany({ where: { tenantId: null, isTemplate: true, deletedAt: null } });
  for (const t of templates) {
    const exists = await owner.role.findFirst({ where: { tenantId, code: t.code } });
    if (exists) continue;
    const copy = await owner.role.create({ data: { tenantId, code: t.code, name: t.name, kind: "custom", templateId: t.id, sort: t.sort } });
    const menus = await owner.roleMenu.findMany({ where: { roleId: t.id } });
    await owner.roleMenu.createMany({ data: menus.map((m) => ({ tenantId, roleId: copy.id, menuId: m.menuId })) });
    const scopes = await owner.roleDataScope.findMany({ where: { roleId: t.id } });
    await owner.roleDataScope.createMany({ data: scopes.map((x) => ({ tenantId, roleId: copy.id, setId: x.setId })) });
    steps.push(`role template ${t.code}`);
  }
  return steps;
}

/** 把最新的菜单目录和角色模板应用到一个已开通的租户（升级用，seed 脚本调用）。 */
export async function applyCatalogToTenant(owner: PrismaClient, tenantId: string): Promise<string[]> {
  await syncPlatformMenus(owner);
  await syncRoleTemplates(owner);
  const steps = await copyMissingTemplates(owner, tenantId);
  const granted = await grantMissingMenus(owner, tenantId);
  if (granted > 0) steps.push(`menu grants (${granted})`);
  return steps;
}
