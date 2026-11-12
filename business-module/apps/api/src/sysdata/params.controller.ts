// 参数：平台提供的只读；租户可以建自己的（键不能与平台提供的重名）。
import { Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { AuditService } from "../audit/audit.service";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";

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
    if (p.tenantId === null) throw new ForbiddenException("Platform-provided parameters are read-only");
    if (p.tenantId !== tenantId) throw new NotFoundException();
    return p;
  }

  @Get()
  @RequirePermissions(PERMS.paramList)
  async list() {
    const rows = await this.tenantDb.db.sysParam.findMany({ orderBy: { key: "asc" } });
    return rows.map((r) => ({ ...r, platformProvided: r.tenantId === null }));
  }

  @Post()
  @RequirePermissions(PERMS.paramAdd)
  async create(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(createSchema, body);
    if (await this.tenantDb.db.sysParam.findFirst({ where: { key: input.key } })) throw new ConflictException("Parameter key already exists");
    const row = await this.tenantDb.db.sysParam.create({ data: { tenantId: auth.tenantId, key: input.key, value: input.value, name: input.name, remark: input.remark ?? null, createdBy: auth.accountId } });
    await this.audit.record(auth.accountId, "param.create", "param", row.id, { key: row.key });
    return row;
  }

  @Patch(":id")
  @RequirePermissions(PERMS.paramEdit)
  async update(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(patchSchema, body);
    const p = await this.own(id, auth.tenantId);
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
