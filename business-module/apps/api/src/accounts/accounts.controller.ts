// 账号接口（B2 范围：列表/详情、创建、停用启用、改邮箱、分配角色、对账）。
// 完整的"用户管理"页面和人员档案联动在 B4/B5。账号属于系统管理类对象，只按权限字符控制（不做行级数据范围）。
import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, paging, parse } from "../common/http";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { AccountsService } from "./accounts.service";

const createSchema = z.object({
  username: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,48}$/, "lowercase letters, digits, dot, underscore, hyphen; 2-49 characters"),
  email: z.string().email().max(200).optional(),
  personId: z.string().uuid().optional(),
  roleIds: z.array(z.string().uuid()).max(50).optional(),
  kind: z.enum(["staff", "student"]).optional(),
  sendInvite: z.boolean().optional(),
});
const statusSchema = z.object({ status: z.enum(["active", "disabled"]) });
const emailSchema = z.object({ email: z.string().email().max(200).nullable() });
const rolesSchema = z.object({ roleIds: z.array(z.string().uuid()).max(50) });
const reconcileSchema = z.object({ fix: z.boolean().default(false) });

@Controller("api/accounts")
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly tenantDb: TenantPrismaService,
  ) {}

  @Get()
  @RequirePermissions(PERMS.userList)
  async list(@Query() query: { page?: string; size?: string }) {
    const db = this.tenantDb.db;
    const rows = await db.account.findMany({ orderBy: { username: "asc" }, ...paging(query) });
    const links = rows.length ? await db.accountRole.findMany({ where: { accountId: { in: rows.map((r) => r.id) } } }) : [];
    return rows.map((r) => ({ ...r, roleIds: links.filter((l) => l.accountId === r.id).map((l) => l.roleId) }));
  }

  @Post("reconcile")
  @RequirePermissions(PERMS.userReconcile)
  reconcile(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.accounts.reconcile(auth.authz, parse(reconcileSchema, body ?? {}).fix);
  }

  @Get(":id")
  @RequirePermissions(PERMS.userList)
  async get(@Param("id", ParseUUIDPipe) id: string) {
    const db = this.tenantDb.db;
    const row = await db.account.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    const links = await db.accountRole.findMany({ where: { accountId: id } });
    return { ...row, roleIds: links.map((l) => l.roleId) };
  }

  @Post()
  @RequirePermissions(PERMS.userAdd)
  create(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.accounts.create(auth.authz, parse(createSchema, body));
  }

  @Patch(":id/status")
  @RequirePermissions(PERMS.userEdit)
  status(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.accounts.setStatus(auth.authz, id, parse(statusSchema, body).status);
  }

  @Patch(":id/email")
  @RequirePermissions(PERMS.userEdit)
  email(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.accounts.updateEmail(auth.authz, id, parse(emailSchema, body).email);
  }

  @Put(":id/roles")
  @RequirePermissions(PERMS.userAssignRole)
  roles(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.accounts.assignRoles(auth.authz, id, parse(rolesSchema, body).roleIds);
  }
}
