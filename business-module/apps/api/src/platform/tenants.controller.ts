// 平台入口的租户管理接口（路径前缀 /api/platform，只在主机名 platform.* 上可用）。
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put } from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { RequirePermissions } from "../auth/decorators";
import { parse } from "../common/http";
import { PAuth, PlatformRoute, type PlatformAuthContext } from "./platform.decorators";
import { TenantUsageService } from "./tenant-usage.service";
import { TenantSecurityService } from "./tenant-security.service";
import { TenantsService } from "./tenants.service";

const createSchema = z.object({
  code: z.string().min(2).max(30),
  name: z.string().trim().min(1).max(200),
  type: z.enum(["direct", "franchise"]).optional(),
  timezone: z.string().max(60).optional(),
  adminEmail: z.string().email().max(200),
  hqCampusName: z.string().trim().min(1).max(200).optional(),
});
// 基本信息：不含 code（开通后只读）；strict 让多传的字段直接报错
const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    shortName: z.string().trim().max(100).nullable().optional(),
    contactName: z.string().trim().max(100).nullable().optional(),
    contactEmail: z.string().email().max(200).nullable().optional(),
    contactPhone: z.string().trim().max(50).nullable().optional(),
    timezone: z.string().max(60).optional(),
    remark: z.string().max(1000).nullable().optional(),
    type: z.enum(["direct", "franchise"]).optional(),
  })
  .strict();
const statusSchema = z.object({
  action: z.enum(["notify", "suspend", "restore", "cancel-notice"]),
  plannedSuspendAt: z.coerce.date().nullable().optional(),
  noticeText: z.string().trim().min(1).max(2000).nullable().optional(),
});
const int = z.number().int();
const securitySchema = z
  .object({
    password: z.object({ length: int, upperCase: int, lowerCase: int, digits: int, specialChars: int, history: int }).strict(),
    lockout: z.object({ failureFactor: int, waitIncrementMinutes: int, maxWaitMinutes: int, permanent: z.boolean() }).strict(),
    session: z.object({ idleMinutes: int, maxHours: int }).strict(),
    mfa: z.enum(["off", "all"]),
  })
  .strict();
const googleSchema = z.object({ clientId: z.string().trim().min(10).max(300), clientSecret: z.string().trim().min(5).max(300).optional(), enabled: z.boolean() }).strict();
const quotaSchema = z.object({ maxAccounts: int.nullable(), maxStorageMb: int.nullable() }).strict();
const grantsSchema = z.object({ menuIds: z.array(z.string().uuid()).max(3000) });

@PlatformRoute()
@Controller("api/platform/tenants")
export class TenantsController {
  constructor(
    private readonly tenants: TenantsService,
    private readonly security: TenantSecurityService,
    private readonly usage: TenantUsageService,
  ) {}

  @Get()
  @RequirePermissions(PERMS.platformTenantList)
  list() {
    return this.tenants.list();
  }

  @Post()
  @RequirePermissions(PERMS.platformTenantAdd)
  create(@PAuth() auth: PlatformAuthContext, @Body() body: unknown) {
    return this.tenants.create(auth.accountId, parse(createSchema, body));
  }

  @Get("usage")
  @RequirePermissions(PERMS.platformTenantQuota)
  listUsage() {
    return this.usage.list();
  }

  @Get(":id")
  @RequirePermissions(PERMS.platformTenantList)
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.tenants.get(id);
  }

  @Patch(":id")
  @RequirePermissions(PERMS.platformTenantEdit)
  update(@PAuth() auth: PlatformAuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.tenants.update(auth.accountId, id, parse(updateSchema, body));
  }

  @Post(":id/status")
  @RequirePermissions(PERMS.platformTenantStatus)
  status(@PAuth() auth: PlatformAuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { action, ...rest } = parse(statusSchema, body);
    return this.tenants.changeStatus(auth.accountId, id, action, rest);
  }

  @Get(":id/grants")
  @RequirePermissions(PERMS.platformTenantList)
  grants(@Param("id", ParseUUIDPipe) id: string) {
    return this.tenants.grants(id);
  }

  @Put(":id/grants")
  @RequirePermissions(PERMS.platformTenantGrant)
  setGrants(@PAuth() auth: PlatformAuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.tenants.setGrants(auth.accountId, id, parse(grantsSchema, body).menuIds);
  }

  @Get(":id/admin")
  @RequirePermissions(PERMS.platformTenantAdmin)
  admin(@Param("id", ParseUUIDPipe) id: string) {
    return this.tenants.admin(id);
  }

  @Post(":id/admin/invite")
  @RequirePermissions(PERMS.platformTenantAdmin)
  invite(@PAuth() auth: PlatformAuthContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.tenants.sendPasswordLink(auth.accountId, id, "invite");
  }

  @Post(":id/admin/reset-password")
  @RequirePermissions(PERMS.platformTenantAdmin)
  reset(@PAuth() auth: PlatformAuthContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.tenants.sendPasswordLink(auth.accountId, id, "reset");
  }

  @Post(":id/admin/unlock")
  @RequirePermissions(PERMS.platformTenantAdmin)
  unlock(@PAuth() auth: PlatformAuthContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.tenants.unlock(auth.accountId, id);
  }

  @Patch(":id/admin/email")
  @RequirePermissions(PERMS.platformTenantAdmin)
  adminEmail(@PAuth() auth: PlatformAuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.tenants.changeAdminEmail(auth.accountId, id, parse(z.object({ email: z.string().email().max(200) }), body).email);
  }

  // ---- 登录与安全
  @Get(":id/usage")
  @RequirePermissions(PERMS.platformTenantQuota)
  getUsage(@Param("id", ParseUUIDPipe) id: string) {
    return this.usage.get(id);
  }

  @Put(":id/quota")
  @RequirePermissions(PERMS.platformTenantQuota)
  setQuota(@PAuth() auth: PlatformAuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.usage.setLimits(auth.accountId, id, parse(quotaSchema, body));
  }

  @Get(":id/security")
  @RequirePermissions(PERMS.platformTenantSecurity)
  getSecurity(@Param("id", ParseUUIDPipe) id: string) {
    return this.security.get(id);
  }

  @Put(":id/security")
  @RequirePermissions(PERMS.platformTenantSecurity)
  setSecurity(@PAuth() auth: PlatformAuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.security.update(auth.accountId, id, parse(securitySchema, body));
  }

  @Put(":id/security/google")
  @RequirePermissions(PERMS.platformTenantSecurity)
  setGoogle(@PAuth() auth: PlatformAuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.security.setGoogle(auth.accountId, id, parse(googleSchema, body));
  }

  @Delete(":id/security/google")
  @RequirePermissions(PERMS.platformTenantSecurity)
  removeGoogle(@PAuth() auth: PlatformAuthContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.security.removeGoogle(auth.accountId, id);
  }
}
