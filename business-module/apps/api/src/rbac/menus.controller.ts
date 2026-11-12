// 菜单管理与入口管理（租户侧）。
//   - 平台提供的菜单（tenant_id 为空）对租户只读；租户自建的只能是"目录"和"外链"，不能建按钮、不能带权限标识；
//   - 租户可以在平台提供的目录下加自己的外链；所属入口跟随顶层目录；
//   - 入口管理：只能把租户自己的顶层菜单分配给"管理后台"或"学生门户"；平台的分配租户只读；
//     未分配的菜单不显示在任何入口（草稿）。
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

const urlOrPath = z.string().trim().max(500);
const createSchema = z
  .object({
    parentId: z.string().uuid().nullable().optional(),
    name: z.string().trim().min(1).max(100),
    type: z.enum(["directory", "link"]),
    /** 外链：完整网址（http/https）；目录：路由片段，可空 */
    route: urlOrPath.optional(),
    icon: z.string().trim().max(50).optional(),
    sort: z.number().int().min(0).max(10000).optional(),
    visible: z.boolean().optional(),
  })
  .strict();
const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    route: urlOrPath.optional(),
    icon: z.string().trim().max(50).nullable().optional(),
    sort: z.number().int().min(0).max(10000).optional(),
    visible: z.boolean().optional(),
    status: z.boolean().optional(),
  })
  .strict();
const assignSchema = z.object({ menus: z.array(z.object({ menuId: z.string().uuid(), sort: z.number().int().min(0).max(10000).default(0) })).max(200) });

function assertHttpUrl(route: string | undefined): void {
  if (!route || !/^https?:\/\/[^\s]+$/i.test(route)) throw new BadRequestException("An external link needs a full http(s) address");
}

@Controller("api/menus")
export class MenusController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
  ) {}

  /** 租户能看到的菜单：平台提供且已开通的 + 自建的；每条标出"平台提供/自建"和所属入口。 */
  @Get()
  @RequirePermissions(PERMS.menuList)
  async list() {
    const graph = await this.authz.graph();
    const entryOf = new Map<string, string[]>();
    for (const code of ["admin", "portal"]) {
      for (const top of graph.topsOfEntry(code).keys()) entryOf.set(top, [...(entryOf.get(top) ?? []), code]);
    }
    return graph.menus
      .filter((m) => (m.tenantId === null ? graph.effective(m.id) : true)) // 平台提供的只列本租户已开通的；自建的都列
      .map((m) => ({
        id: m.id,
        parentId: m.parentId,
        code: m.code,
        name: m.name,
        nameKey: m.nameKey,
        type: m.type,
        route: m.route,
        component: m.component,
        perms: m.perms,
        icon: m.icon,
        sort: m.sort,
        visible: m.visible,
        status: m.status,
        platformProvided: m.tenantId === null,
        entries: entryOf.get(graph.topOf(m.id)) ?? [], // 空 = 未分配入口
      }))
      .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  }

  private async ownMenu(id: string) {
    const tenant = requireTenant("read menu");
    const menu = await this.tenantDb.db.menu.findUnique({ where: { id } });
    if (!menu) throw new NotFoundException();
    if (menu.tenantId === null) throw new ForbiddenException("Platform-provided menus are read-only");
    if (menu.tenantId !== tenant.tenantId) throw new NotFoundException();
    return menu;
  }

  @Post()
  @RequirePermissions(PERMS.menuAdd)
  async create(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(createSchema, body);
    if (input.type === "link") assertHttpUrl(input.route);
    const db = this.tenantDb.db;
    if (input.parentId) {
      const graph = await this.authz.graph();
      const parent = graph.byId.get(input.parentId);
      if (!parent || !graph.effective(parent.id)) throw new BadRequestException("Unknown parent menu");
      if (parent.type !== "directory") throw new BadRequestException("A menu can only be added under a directory");
    }
    const row = await db.menu.create({
      data: {
        tenantId: auth.tenantId,
        parentId: input.parentId ?? null,
        name: input.name,
        type: input.type,
        route: input.route ?? null,
        icon: input.icon ?? null,
        sort: input.sort ?? 0,
        visible: input.visible ?? true,
        createdBy: auth.accountId,
      },
    });
    await this.authz.bump(auth.tenantId);
    await this.audit.record(auth.accountId, "menu.create", "menu", row.id, { name: row.name, type: row.type });
    return row;
  }

  @Patch(":id")
  @RequirePermissions(PERMS.menuEdit)
  async update(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(patchSchema, body);
    const menu = await this.ownMenu(id);
    if (input.route !== undefined && menu.type === "link") assertHttpUrl(input.route);
    const row = await this.tenantDb.db.menu.update({ where: { id }, data: { ...input, updatedBy: auth.accountId } });
    await this.authz.bump(auth.tenantId);
    await this.audit.record(auth.accountId, "menu.update", "menu", id, input);
    return row;
  }

  @Delete(":id")
  @RequirePermissions(PERMS.menuRemove)
  async remove(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    await this.ownMenu(id);
    const db = this.tenantDb.db;
    if ((await db.menu.count({ where: { parentId: id } })) > 0) throw new ConflictException("The menu still has sub-menus");
    await this.tenantDb.transaction(async (tx) => {
      await tx.roleMenu.deleteMany({ where: { menuId: id } });
      await tx.entryMenu.deleteMany({ where: { menuId: id } });
      await tx.menu.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: auth.accountId } });
    });
    await this.authz.bump(auth.tenantId);
    await this.audit.record(auth.accountId, "menu.delete", "menu", id);
    return { id };
  }
}

@Controller("api/entries")
export class EntriesController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
  ) {}

  /** 管理后台和学生门户（平台入口不对租户开放）：各自分配到的顶层菜单，以及"未分配入口"的菜单。 */
  @Get()
  @RequirePermissions(PERMS.entryList)
  async list() {
    const db = this.tenantDb.db;
    const graph = await this.authz.graph();
    const entries = (await db.entry.findMany()).filter((e) => e.code !== "platform");
    const assignments = await db.entryMenu.findMany({});
    const assignedTops = new Set(assignments.map((a) => a.menuId));
    const view = (menuId: string, sort: number) => {
      const m = graph.byId.get(menuId);
      return m ? { menuId, name: m.name, nameKey: m.nameKey, sort, platformProvided: m.tenantId === null, effective: graph.effective(menuId) } : null;
    };
    return {
      entries: entries.map((e) => ({
        code: e.code,
        name: e.name,
        menus: assignments
          .filter((a) => a.entryId === e.id)
          .map((a) => view(a.menuId, a.sort))
          .filter((x): x is NonNullable<typeof x> => x !== null)
          .sort((a, b) => a.sort - b.sort),
      })),
      unassigned: graph.menus
        .filter((m) => !m.parentId && m.tenantId !== null && !assignedTops.has(m.id))
        .map((m) => ({ menuId: m.id, name: m.name, nameKey: m.nameKey, platformProvided: false })),
    };
  }

  /** 把租户自己的顶层菜单分配给入口（整体替换该入口里"租户自己分配的"部分，平台分配的不动）。 */
  @Put(":code/menus")
  @RequirePermissions(PERMS.entryEdit)
  async assign(@Auth() auth: AuthContext, @Param("code") code: string, @Body() body: unknown) {
    const { menus } = parse(assignSchema, body);
    if (code !== "admin" && code !== "portal") throw new NotFoundException();
    const db = this.tenantDb.db;
    const entry = await db.entry.findFirst({ where: { code } });
    if (!entry) throw new NotFoundException();
    const ids = [...new Set(menus.map((m) => m.menuId))];
    await assertVisible(db.menu, ids, "menu");
    const rows = ids.length ? await db.menu.findMany({ where: { id: { in: ids } } }) : [];
    if (rows.some((m) => m.parentId !== null)) throw new BadRequestException("Only top-level menus can be assigned to an entry");
    if (rows.some((m) => m.tenantId !== auth.tenantId)) throw new ForbiddenException("Platform-provided assignments are read-only");

    await this.tenantDb.transaction(async (tx) => {
      await tx.entryMenu.deleteMany({ where: { entryId: entry.id, tenantId: auth.tenantId } });
      if (menus.length) {
        await tx.entryMenu.createMany({ data: menus.map((m) => ({ tenantId: auth.tenantId, entryId: entry.id, menuId: m.menuId, sort: m.sort })) });
      }
    });
    await this.authz.bump(auth.tenantId);
    await this.audit.record(auth.accountId, "entry.assign", "entry", entry.id, { code, menuIds: ids });
    return { code, menus };
  }
}
