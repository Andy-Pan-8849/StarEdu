// 平台账号与平台角色（和租户同一套 RBAC 机制，但完全独立的表和域）、平台菜单与入口管理、平台日志、"我"。
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { AnyAuthenticated, RequirePermissions } from "../auth/decorators";
import { SessionStore } from "../auth/session-store";
import { paging, parse } from "../common/http";
import { KeycloakService } from "../keycloak/keycloak.service";
import { tenantOrigin } from "../keycloak/realm-provisioner";
import { PAuth, PlatformRoute, type PlatformAuthContext } from "./platform.decorators";
import { PlatformAuditService } from "./platform-audit.service";
import { PlatformAuthzService } from "./platform-authz.service";
import { PlatformPrismaService } from "./platform-prisma.service";

const accountSchema = z.object({
  username: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,48}$/),
  email: z.string().email().max(200),
  roleIds: z.array(z.string().uuid()).max(20).optional(),
});
const roleSchema = z.object({ code: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/), name: z.string().trim().min(1).max(100), sort: z.number().int().min(0).max(10000).optional() });
const menusSchema = z.object({ menuIds: z.array(z.string().uuid()).max(500) });
const rolesSchema = z.object({ roleIds: z.array(z.string().uuid()).max(20) });
const statusSchema = z.object({ status: z.enum(["active", "disabled"]) });

@PlatformRoute()
@Controller("api/platform")
export class PlatformController {
  constructor(
    private readonly db: PlatformPrismaService,
    private readonly authz: PlatformAuthzService,
    private readonly audit: PlatformAuditService,
    private readonly keycloak: KeycloakService,
    private readonly sessions: SessionStore,
  ) {}

  // ---- 我 ----
  @Get("me")
  @AnyAuthenticated()
  async me(@PAuth() auth: PlatformAuthContext) {
    return { id: auth.accountId, username: auth.username, permissions: auth.perms, isSuper: auth.isSuper };
  }

  /** 登录登记：能拿到平台域令牌说明已经设好密码，待激活的账号在这里变为正常（和租户入口同一规则）。 */
  @Post("auth/session")
  @AnyAuthenticated()
  async session(@PAuth() auth: PlatformAuthContext) {
    const row = await this.db.platformAccount.findFirst({ where: { id: auth.accountId, deletedAt: null } });
    if (row?.status === "pending") {
      await this.db.platformAccount.update({ where: { id: row.id }, data: { status: "active" } });
      await this.authz.bump();
    }
    await this.audit.record(auth.accountId, "platform.login", "platformAccount", auth.accountId);
    return { id: auth.accountId, username: auth.username };
  }

  @Get("me/menus")
  @AnyAuthenticated()
  async myMenus(@PAuth() auth: PlatformAuthContext) {
    const loaded = await this.authz.load(auth.accountId);
    const ticked = new Set(loaded?.menuIds ?? []);
    return (await this.authz.graph()).tree("platform", (m) => ticked.has(m.id));
  }

  // ---- 平台账号 ----
  @Get("accounts")
  @RequirePermissions(PERMS.platformAccountList)
  async accounts() {
    const rows = await this.db.platformAccount.findMany({ where: { deletedAt: null }, orderBy: { username: "asc" } });
    const links = await this.db.platformAccountRole.findMany({});
    return rows.map((r) => ({ id: r.id, username: r.username, email: r.email, status: r.status, isBuiltin: r.isBuiltin, roleIds: links.filter((l) => l.accountId === r.id).map((l) => l.roleId) }));
  }

  @Post("accounts")
  @RequirePermissions(PERMS.platformAccountAdd)
  async createAccount(@PAuth() auth: PlatformAuthContext, @Body() body: unknown) {
    const input = parse(accountSchema, body);
    await this.assertAssignable(auth, input.roleIds ?? []);
    let row;
    try {
      row = await this.db.platformAccount.create({ data: { username: input.username, email: input.email, status: "pending" } });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw new ConflictException("Username or e-mail already in use");
      throw err;
    }
    if (input.roleIds?.length) await this.db.platformAccountRole.createMany({ data: input.roleIds.map((roleId) => ({ accountId: row.id, roleId })) });
    let inviteSent = false;
    try {
      const kc = await this.keycloak.client();
      const userId = await kc.createUser("platform", { username: row.username, email: row.email ?? undefined, accountId: row.id });
      await this.db.platformAccount.update({ where: { id: row.id }, data: { keycloakUserId: userId } });
      await kc.sendInvite("platform", userId, "platform", tenantOrigin("platform"));
      inviteSent = true;
    } catch {
      /* 账号留在"待激活、没有 Keycloak 用户"；重试时先删再建（B3 范围内没有平台对账） */
    }
    await this.authz.bump();
    await this.audit.record(auth.accountId, "platformAccount.create", "platformAccount", row.id, { username: row.username, inviteSent });
    return { id: row.id, username: row.username, status: row.status, inviteSent };
  }

  @Patch("accounts/:id/status")
  @RequirePermissions(PERMS.platformAccountEdit)
  async setStatus(@PAuth() auth: PlatformAuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { status } = parse(statusSchema, body);
    const row = await this.db.platformAccount.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw new NotFoundException();
    if (row.isBuiltin) throw new ForbiddenException("The built-in platform account cannot be disabled");
    if (row.id === auth.accountId) throw new ForbiddenException("You cannot disable your own account");
    await this.db.platformAccount.update({ where: { id }, data: { status } });
    await this.authz.bump();
    let synced = true;
    if (row.keycloakUserId) {
      try {
        await (await this.keycloak.client()).updateUser("platform", row.keycloakUserId, { enabled: status === "active" });
      } catch {
        synced = false;
      }
    }
    await this.audit.record(auth.accountId, "platformAccount.status", "platformAccount", id, { to: status, synced });
    return { id, status, synced };
  }

  @Put("accounts/:id/roles")
  @RequirePermissions(PERMS.platformAccountAssignRole)
  async assignRoles(@PAuth() auth: PlatformAuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { roleIds } = parse(rolesSchema, body);
    const row = await this.db.platformAccount.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw new NotFoundException();
    if (row.isBuiltin) throw new ForbiddenException("The built-in platform account's roles cannot be changed");
    const wanted = [...new Set(roleIds)];
    await this.assertAssignable(auth, wanted);
    await this.db.$transaction([
      this.db.platformAccountRole.deleteMany({ where: { accountId: id } }),
      this.db.platformAccountRole.createMany({ data: wanted.map((roleId) => ({ accountId: id, roleId })) }),
    ]);
    await this.authz.bump();
    await this.audit.record(auth.accountId, "platformAccount.roles", "platformAccount", id, { after: wanted.sort() });
    return { id, roleIds: wanted };
  }

  /** 只能分配存在的、自定义的、权限不超过自己的角色（防提权）。 */
  private async assertAssignable(auth: PlatformAuthContext, roleIds: string[]): Promise<void> {
    if (roleIds.length === 0) return;
    const roles = await this.db.platformRole.findMany({ where: { id: { in: [...new Set(roleIds)] }, deletedAt: null } });
    if (roles.length !== new Set(roleIds).size) throw new BadRequestException("Unknown role");
    if (roles.some((r) => r.kind !== "custom")) throw new ForbiddenException("Built-in roles cannot be assigned manually");
    const graph = await this.authz.graph();
    const mine = new Set(auth.perms);
    const rm = await this.db.platformRoleMenu.findMany({ where: { roleId: { in: roles.map((r) => r.id) } } });
    for (const link of rm) {
      const perm = graph.byId.get(link.menuId)?.perms;
      if (perm && !mine.has(perm)) throw new ForbiddenException("You cannot grant permissions you do not have");
    }
  }

  // ---- 平台角色 ----
  @Get("roles")
  @RequirePermissions(PERMS.platformRoleList)
  roles() {
    return this.db.platformRole.findMany({ where: { deletedAt: null }, orderBy: [{ sort: "asc" }, { code: "asc" }] });
  }

  @Get("roles/menu-tree")
  @RequirePermissions(PERMS.platformRoleList)
  async roleMenuTree() {
    return (await this.authz.graph()).tree("platform", () => true, { forEditor: true });
  }

  @Get("roles/:id")
  @RequirePermissions(PERMS.platformRoleList)
  async role(@Param("id", ParseUUIDPipe) id: string) {
    const r = await this.db.platformRole.findFirst({ where: { id, deletedAt: null } });
    if (!r) throw new NotFoundException();
    return { ...r, menuIds: (await this.db.platformRoleMenu.findMany({ where: { roleId: id } })).map((m) => m.menuId) };
  }

  @Post("roles")
  @RequirePermissions(PERMS.platformRoleAdd)
  async createRole(@PAuth() auth: PlatformAuthContext, @Body() body: unknown) {
    const input = parse(roleSchema, body);
    try {
      const r = await this.db.platformRole.create({ data: { code: input.code, name: input.name, sort: input.sort ?? 0 } });
      await this.audit.record(auth.accountId, "platformRole.create", "platformRole", r.id, { code: r.code });
      return r;
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw new ConflictException("Role code already exists");
      throw err;
    }
  }

  private async customRole(id: string) {
    const r = await this.db.platformRole.findFirst({ where: { id, deletedAt: null } });
    if (!r) throw new NotFoundException();
    if (r.kind !== "custom") throw new ForbiddenException("Built-in roles cannot be changed");
    return r;
  }

  @Delete("roles/:id")
  @RequirePermissions(PERMS.platformRoleRemove)
  async removeRole(@PAuth() auth: PlatformAuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const r = await this.customRole(id);
    if ((await this.db.platformAccountRole.count({ where: { roleId: id } })) > 0) throw new ConflictException("The role is still assigned to accounts");
    await this.db.platformRole.update({ where: { id }, data: { deletedAt: new Date(), code: `${r.code}~deleted~${Date.now()}` } });
    await this.authz.bump();
    await this.audit.record(auth.accountId, "platformRole.delete", "platformRole", id, { code: r.code });
    return { id };
  }

  @Put("roles/:id/menus")
  @RequirePermissions(PERMS.platformRoleAuthorize)
  async setRoleMenus(@PAuth() auth: PlatformAuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { menuIds } = parse(menusSchema, body);
    await this.customRole(id);
    const graph = await this.authz.graph();
    const allowed = new Set(graph.menusOfEntry("platform").map((m) => m.id));
    const wanted = [...new Set(menuIds)];
    if (!wanted.every((m) => allowed.has(m))) throw new BadRequestException("Unknown menu");
    const mine = new Set(auth.perms);
    if (wanted.some((m) => { const p = graph.byId.get(m)?.perms; return !!p && !mine.has(p); })) {
      throw new ForbiddenException("You cannot grant permissions you do not have");
    }
    await this.db.$transaction([
      this.db.platformRoleMenu.deleteMany({ where: { roleId: id } }),
      this.db.platformRoleMenu.createMany({ data: wanted.map((menuId) => ({ roleId: id, menuId })) }),
    ]);
    await this.authz.bump();
    await this.audit.record(auth.accountId, "platformRole.menus", "platformRole", id, { count: wanted.length });
    return { id, menuIds: wanted };
  }

  // ---- 平台菜单与入口管理（平台提供的部分） ----
  @Get("menus")
  @RequirePermissions(PERMS.platformMenuList)
  async menus() {
    const graph = await this.authz.graph();
    const entryOf = new Map<string, string[]>();
    for (const code of ["admin", "portal", "platform"]) for (const top of graph.topsOfEntry(code).keys()) entryOf.set(top, [...(entryOf.get(top) ?? []), code]);
    return graph.menus.map((m) => ({ id: m.id, parentId: m.parentId, code: m.code, name: m.name, type: m.type, route: m.route, component: m.component, perms: m.perms, sort: m.sort, visible: m.visible, status: m.status, entries: entryOf.get(graph.topOf(m.id)) ?? [] }));
  }

  /** 平台只能调整"显示"、"启用"和排序；菜单本身（名称、路由、权限标识）由代码里的目录定义，下次同步会还原。 */
  @Patch("menus/:id")
  @RequirePermissions(PERMS.platformMenuEdit)
  async patchMenu(@PAuth() auth: PlatformAuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(z.object({ visible: z.boolean().optional(), status: z.boolean().optional(), sort: z.number().int().min(0).max(10000).optional() }).strict(), body);
    const m = await this.db.menu.findFirst({ where: { id, tenantId: null, deletedAt: null } });
    if (!m) throw new NotFoundException();
    const row = await this.db.menu.update({ where: { id }, data: input });
    await this.authz.bump();
    await this.audit.record(auth.accountId, "menu.platformUpdate", "menu", id, input);
    return row;
  }

  @Get("entries")
  @RequirePermissions(PERMS.platformEntryList)
  async entries() {
    const graph = await this.authz.graph();
    const entries = await this.db.entry.findMany();
    return entries.map((e) => ({ code: e.code, name: e.name, menus: [...graph.topsOfEntry(e.code).entries()].map(([menuId, sort]) => ({ menuId, sort, name: graph.byId.get(menuId)?.name })) }));
  }

  @Put("entries/:code/menus")
  @RequirePermissions(PERMS.platformEntryEdit)
  async setEntryMenus(@PAuth() auth: PlatformAuthContext, @Param("code") code: string, @Body() body: unknown) {
    const { menus } = parse(z.object({ menus: z.array(z.object({ menuId: z.string().uuid(), sort: z.number().int().min(0).default(0) })).max(200) }), body);
    const entry = await this.db.entry.findFirst({ where: { code } });
    if (!entry) throw new NotFoundException();
    const rows = menus.length ? await this.db.menu.findMany({ where: { id: { in: menus.map((m) => m.menuId) }, tenantId: null, deletedAt: null } }) : [];
    if (rows.length !== new Set(menus.map((m) => m.menuId)).size || rows.some((r) => r.parentId !== null)) throw new BadRequestException("Only top-level platform menus can be assigned");
    await this.db.$transaction([
      this.db.entryMenu.deleteMany({ where: { entryId: entry.id, tenantId: null } }),
      this.db.entryMenu.createMany({ data: menus.map((m) => ({ tenantId: null, entryId: entry.id, menuId: m.menuId, sort: m.sort })) }),
    ]);
    await this.authz.bump();
    await this.audit.record(auth.accountId, "entry.platformAssign", "entry", entry.id, { code, count: menus.length });
    return { code, menus };
  }

  // ---- 日志 ----
  @Get("audit-logs")
  @RequirePermissions(PERMS.platformLogList)
  auditLogs(@Query() query: { page?: string; size?: string }) {
    return this.db.platformAuditLog.findMany({ orderBy: { createdAt: "desc" }, ...paging(query) });
  }
}
