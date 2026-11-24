// 参数：平台提供的是"默认值"，租户可以为它设自己的值（覆盖），删掉覆盖就恢复默认；租户也可以建自己的参数。
//   列表里每个键只出现一次：有本租户的值就显示它，否则显示平台默认。已知的键按登记的类型和范围校验。
import { Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { AuditService } from "../audit/audit.service";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { assertParam } from "./params.service";

const createSchema = z.object({ key: z.string().regex(/^[a-z][a-zA-Z0-9.]{1,80}$/), value: z.string().max(2000), name: z.string().trim().min(1).max(200), remark: z.string().max(500).optional() });
const patchSchema = z.object({ value: z.string().max(2000).optional(), name: z.string().trim().min(1).max(200).optional(), remark: z.string().max(500).nullable().optional() }).strict();

@Controller("api/params")
export class ParamsController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly audit: AuditService,
  ) {}

  private async own(id: string, tenantId: string) {
    const p = await this.tenantDb.db.sysParam.findUnique({ where: { id } });
    if (!p) throw new NotFoundException();
    if (p.tenantId === null) throw new ForbiddenException("Platform-provided parameters are defaults; set your own value instead");
    if (p.tenantId !== tenantId) throw new NotFoundException();
    return p;
  }

  @Get()
  @RequirePermissions(PERMS.paramList)
  async list(@Auth() auth: AuthContext) {
    const rows = await this.tenantDb.db.sysParam.findMany({ orderBy: { key: "asc" } });
    const platform = new Map(rows.filter((r) => r.tenantId === null).map((r) => [r.key, r]));
    const own = new Map(rows.filter((r) => r.tenantId === auth.tenantId).map((r) => [r.key, r]));
    return [...new Set(rows.map((r) => r.key))].sort().map((key) => {
      const o = own.get(key);
      const d = platform.get(key);
      const row = (o ?? d)!;
      return { ...row, platformProvided: !o, overridden: !!o && !!d, defaultValue: d?.value ?? null };
    });
  }

  @Post()
  @RequirePermissions(PERMS.paramAdd)
  async create(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(createSchema, body);
    if (await this.tenantDb.db.sysParam.findFirst({ where: { key: input.key, tenantId: auth.tenantId } })) throw new ConflictException("Parameter key already exists");
    assertParam(input.key, input.value);
    // 平台提供的键：本租户设自己的值，名称沿用平台的
    const base = await this.tenantDb.db.sysParam.findFirst({ where: { key: input.key, tenantId: null } });
    const row = await this.tenantDb.db.sysParam.create({ data: { tenantId: auth.tenantId, key: input.key, value: input.value, name: base?.name ?? input.name, nameKey: base?.nameKey ?? null, remark: input.remark ?? null, createdBy: auth.accountId } });
    await this.audit.record(auth.accountId, "param.create", "param", row.id, { key: row.key });
    return row;
  }

  @Patch(":id")
  @RequirePermissions(PERMS.paramEdit)
  async update(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(patchSchema, body);
    const p = await this.own(id, auth.tenantId);
    if (input.value !== undefined) assertParam(p.key, input.value);
    const row = await this.tenantDb.db.sysParam.update({ where: { id }, data: { ...input, updatedBy: auth.accountId } });
    await this.audit.record(auth.accountId, "param.update", "param", id, { key: p.key });
    return row;
  }

  @Delete(":id")
  @RequirePermissions(PERMS.paramRemove)
  async remove(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const p = await this.own(id, auth.tenantId);
    await this.tenantDb.db.sysParam.update({ where: { id }, data: { deletedAt: new Date(), key: `${p.key}~deleted~${Date.now()}` } });
    await this.audit.record(auth.accountId, "param.delete", "param", id, { key: p.key });
    return { id };
  }
}
