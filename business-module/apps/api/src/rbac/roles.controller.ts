// 角色管理：自建角色的增删改、勾选菜单与按钮（操作权限）、选择数据权限集。
//   - 内置角色（租户管理员、学生）不可改、不可删；
//   - 勾选的菜单必须是本租户已开通、属于管理后台入口的；所有关联 id 都先确认属于本租户；
//   - 防提权：只能新增自己也拥有的权限；
//   - 权限变更写操作日志，并让该租户的权限缓存立即作废（权限版本号加一）。
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
} from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { AuditService } from "../audit/audit.service";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { assertVisible } from "../tenancy/owned";
import { requireTenant } from "../tenancy/request-scope";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { AuthzService } from "./authz.service";

const createSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, "lowercase letters, digits and hyphens, 2-41 characters"),
  name: z.string().trim().min(1).max(100),
  sort: z.number().int().min(0).max(10000).optional(),
});
const patchSchema = z.object({ name: z.string().trim().min(1).max(100).optional(), sort: z.number().int().min(0).max(10000).optional() });
const menusSchema = z.object({ menuIds: z.array(z.string().uuid()).max(2000) });
const scopesSchema = z.object({ setIds: z.array(z.string().uuid()).max(100) });

@Controller("api/roles")
export class RolesController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
  ) {}

  /** 本租户自己的角色（平台角色模板不在租户的角色列表里，开通时已复制）。 */
  private async own(id: string) {
    const tenant = requireTenant("read role");
    const role = await this.tenantDb.db.role.findFirst({ where: { id, tenantId: tenant.tenantId } });
    if (!role) throw new NotFoundException();
    return role;
  }

  private async customOwn(id: string) {
    const role = await this.own(id);
    if (role.kind !== "custom") throw new ForbiddenException("Built-in roles cannot be changed");
    return role;
  }

  /**
   * 角色模板新增的菜单：模板里有、这个角色副本里没有、并且本公司已开通（管理后台入口下）的。
   * 只比"缺什么"，不比"多什么"——公司自己加的、删的都不算差异（删掉的会再出现在"缺"里，由管理员决定要不要补）。
   */
  private async templateMissing(role: { id: string; templateId: string | null }, graph: Awaited<ReturnType<AuthzService["graph"]>>) {
    if (!role.templateId) return null;
    const db = this.tenantDb.db;
    const template = await db.role.findFirst({ where: { id: role.templateId, tenantId: null, deletedAt: null } });
    if (!template) return null;
    const [have, want] = await Promise.all([db.roleMenu.findMany({ where: { roleId: role.id } }), db.roleMenu.findMany({ where: { roleId: template.id } })]);
    const haveIds = new Set(have.map((m) => m.menuId));
    const allowed = new Set(graph.menusOfEntry("admin").map((m) => m.id));
    const missing = want.map((m) => m.menuId).filter((m) => !haveIds.has(m) && allowed.has(m));
    return { template, missing };
  }

  @Get()
  @RequirePermissions(PERMS.roleList)
  async list() {
    const tenant = requireTenant("list roles");
    const roles = await this.tenantDb.db.role.findMany({ where: { tenantId: tenant.tenantId }, orderBy: [{ sort: "asc" }, { code: "asc" }] });
    const graph = await this.authz.graph();
    return Promise.all(roles.map(async (r) => ({ ...r, templateMissingCount: (await this.templateMissing(r, graph))?.missing.length ?? 0 })));
  }

  /** 角色编辑页的菜单树：本租户已开通的、管理后台入口下的全部目录/菜单/按钮。 */
  @Get("menu-tree")
  @RequirePermissions(PERMS.roleList)
  async menuTree() {
    return (await this.authz.graph()).tree("admin", () => true, { forEditor: true });
  }

  @Get(":id")
  @RequirePermissions(PERMS.roleList)
  async get(@Param("id", ParseUUIDPipe) id: string) {
    const role = await this.own(id);
    const db = this.tenantDb.db;
    const menus = await db.roleMenu.findMany({ where: { roleId: id } });
    const scopes = await db.roleDataScope.findMany({ where: { roleId: id } });
    return { ...role, menuIds: menus.map((m) => m.menuId), dataScopeSetIds: scopes.map((s) => s.setId) };
  }

  @Post()
  @RequirePermissions(PERMS.roleAdd)
  async create(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(createSchema, body);
    const tenant = requireTenant("create role");
    try {
      const role = await this.tenantDb.db.role.create({
        data: { tenantId: tenant.tenantId, code: input.code, name: input.name, sort: input.sort ?? 0, kind: "custom", createdBy: auth.accountId },
      });
      await this.audit.record(auth.accountId, "role.create", "role", role.id, { code: role.code });
      return role;
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw new ConflictException("Role code already exists");
      throw err;
    }
  }

  @Patch(":id")
  @RequirePermissions(PERMS.roleEdit)
  async update(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(patchSchema, body);
    await this.customOwn(id);
    const role = await this.tenantDb.db.role.update({ where: { id }, data: { ...input, updatedBy: auth.accountId } });
    await this.audit.record(auth.accountId, "role.update", "role", id, input);
    return role;
  }

  @Delete(":id")
  @RequirePermissions(PERMS.roleRemove)
  async remove(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const role = await this.customOwn(id);
    const db = this.tenantDb.db;
    if ((await db.accountRole.count({ where: { roleId: id } })) > 0) throw new ConflictException("The role is still assigned to accounts");
    // 软删除；改掉编码，让编码可以重新使用
    await db.role.update({ where: { id }, data: { deletedAt: new Date(), code: `${role.code}~deleted~${Date.now()}`, updatedBy: auth.accountId } });
    await this.authz.bump(auth.tenantId);
    await this.audit.record(auth.accountId, "role.delete", "role", id, { code: role.code });
    return { id };
  }

  @Put(":id/menus")
  @RequirePermissions(PERMS.roleAuthorize)
  async setMenus(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { menuIds } = parse(menusSchema, body);
    await this.customOwn(id);
    const wanted = [...new Set(menuIds)];
    const db = this.tenantDb.db;
    await assertVisible(db.menu, wanted, "menu");
    const graph = await this.authz.graph();
    const allowed = new Set(graph.menusOfEntry("admin").map((m) => m.id)); // 已开通、管理后台入口下
    if (!wanted.every((m) => allowed.has(m))) throw new BadRequestException("Unknown menu");

    const current = (await db.roleMenu.findMany({ where: { roleId: id } })).map((m) => m.menuId);
    const added = wanted.filter((m) => !current.includes(m));
    const removed = current.filter((m) => !wanted.includes(m));
    // 防提权：新增的权限必须是操作者自己也拥有的
    const mine = new Set(auth.authz.perms);
    const escalating = added.map((m) => graph.byId.get(m)?.perms).filter((p): p is string => !!p && !mine.has(p));
    if (escalating.length > 0) throw new ForbiddenException("You cannot grant permissions you do not have");

    await this.tenantDb.transaction(async (tx) => {
      await tx.roleMenu.deleteMany({ where: { roleId: id } });
      if (wanted.length) await tx.roleMenu.createMany({ data: wanted.map((menuId) => ({ tenantId: auth.tenantId, roleId: id, menuId })) });
    });
    await this.authz.bump(auth.tenantId);
    await this.audit.record(auth.accountId, "role.menus", "role", id, {
      added: added.map((m) => graph.byId.get(m)?.code ?? graph.byId.get(m)?.name ?? m),
      removed: removed.map((m) => graph.byId.get(m)?.code ?? graph.byId.get(m)?.name ?? m),
    });
    return { id, menuIds: wanted };
  }

  /** 这个角色和它的模板比，缺哪些新菜单（预览，不改任何东西）。 */
  @Get(":id/template-diff")
  @RequirePermissions(PERMS.roleList)
  async templateDiff(@Param("id", ParseUUIDPipe) id: string) {
    const role = await this.own(id);
    const graph = await this.authz.graph();
    const diff = await this.templateMissing(role, graph);
    if (!diff) throw new NotFoundException("This role has no template");
    return {
      template: { code: diff.template.code, name: diff.template.name },
      missing: diff.missing.map((m) => ({ menuId: m, code: graph.byId.get(m)?.code ?? null, name: graph.byId.get(m)?.name ?? "", type: graph.byId.get(m)?.type ?? "menu" })),
    };
  }

  /**
   * 把模板里新增的菜单补进这个角色（只增不减，公司自己调过的勾选不动）。
   * 和手动勾选同样的限制：只能是本公司已开通的菜单，且不能给出操作者自己没有的权限。
   */
  @Post(":id/template-upgrade")
  @RequirePermissions(PERMS.roleAuthorize)
  async templateUpgrade(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    await this.customOwn(id);
    const graph = await this.authz.graph();
    const diff = await this.templateMissing(await this.own(id), graph);
    if (!diff) throw new NotFoundException("This role has no template");
    const mine = new Set(auth.authz.perms);
    const escalating = diff.missing.map((m) => graph.byId.get(m)?.perms).filter((p): p is string => !!p && !mine.has(p));
    if (escalating.length > 0) throw new ForbiddenException("You cannot grant permissions you do not have");
    if (diff.missing.length === 0) return { id, added: [] };
    await this.tenantDb.db.roleMenu.createMany({ data: diff.missing.map((menuId) => ({ tenantId: auth.tenantId, roleId: id, menuId })), skipDuplicates: true });
    await this.authz.bump(auth.tenantId);
    const added = diff.missing.map((m) => graph.byId.get(m)?.code ?? graph.byId.get(m)?.name ?? m);
    await this.audit.record(auth.accountId, "role.templateUpgrade", "role", id, { template: diff.template.code, added });
    return { id, added };
  }

  @Put(":id/data-scopes")
  @RequirePermissions(PERMS.roleAuthorize)
  async setDataScopes(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { setIds } = parse(scopesSchema, body);
    await this.customOwn(id);
    const wanted = [...new Set(setIds)];
    const db = this.tenantDb.db;
    await assertVisible(db.dataScopeSet, wanted, "data scope set");
    const before = (await db.roleDataScope.findMany({ where: { roleId: id } })).map((s) => s.setId);
    await this.tenantDb.transaction(async (tx) => {
      await tx.roleDataScope.deleteMany({ where: { roleId: id } });
      if (wanted.length) await tx.roleDataScope.createMany({ data: wanted.map((setId) => ({ tenantId: auth.tenantId, roleId: id, setId })) });
    });
    await this.authz.bump(auth.tenantId);
    await this.audit.record(auth.accountId, "role.dataScopes", "role", id, { before: before.sort(), after: wanted.sort() });
    return { id, dataScopeSetIds: wanted };
  }
}
