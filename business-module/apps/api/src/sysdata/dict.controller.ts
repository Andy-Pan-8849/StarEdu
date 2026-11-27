// 字典：平台提供的类型和条目对租户只读；租户可以建自己的类型，也可以往平台的类型里追加自己的条目（只有自己的条目能改、能删）。
//   - 类型编码不能与平台提供的重名；条目的值在类型内唯一；
//   - 名称和条目文字可以带翻译键（平台提供的）；租户自建的直接存文字；
//   - `GET /api/dicts/:code` 给下拉框用，任何已登录账号可读，只返回启用的条目。没有服务端缓存（读很便宜），改了立即生效。
import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { AuditService } from "../audit/audit.service";
import { AnyAuthenticated, RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";

const typeSchema = z.object({ code: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), name: z.string().trim().min(1).max(100), remark: z.string().max(500).optional() });
const typePatch = z.object({ name: z.string().trim().min(1).max(100).optional(), status: z.boolean().optional(), remark: z.string().max(500).nullable().optional() }).strict();
const itemSchema = z.object({ value: z.string().trim().min(1).max(100), label: z.string().trim().min(1).max(200), remark: z.string().max(500).optional(), sort: z.number().int().min(0).max(10000).optional() });
const itemPatch = z.object({ label: z.string().trim().min(1).max(200).optional(), remark: z.string().max(500).nullable().optional(), sort: z.number().int().min(0).max(10000).optional(), status: z.boolean().optional() }).strict();

@Controller("api")
export class DictController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly audit: AuditService,
  ) {}

  private async ownType(id: string, tenantId: string) {
    const t = await this.tenantDb.db.dictType.findUnique({ where: { id } });
    if (!t) throw new NotFoundException();
    if (t.tenantId === null) throw new ForbiddenException("Platform-provided dictionaries are read-only");
    if (t.tenantId !== tenantId) throw new NotFoundException();
    return t;
  }

  @Get("dict-types")
  @RequirePermissions(PERMS.dictList)
  async types() {
    const rows = await this.tenantDb.db.dictType.findMany({ orderBy: [{ code: "asc" }] });
    return rows.map((r) => ({ ...r, platformProvided: r.tenantId === null }));
  }

  @Post("dict-types")
  @RequirePermissions(PERMS.dictAdd)
  async createType(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(typeSchema, body);
    // 编码不能和平台提供的重名（租户读到的列表里平台的也可见，所以直接查）
    if (await this.tenantDb.db.dictType.findFirst({ where: { code: input.code } })) throw new ConflictException("Dictionary code already exists");
    const row = await this.tenantDb.db.dictType.create({ data: { tenantId: auth.tenantId, code: input.code, name: input.name, remark: input.remark ?? null, createdBy: auth.accountId } });
    await this.audit.record(auth.accountId, "dict.create", "dictType", row.id, { code: row.code });
    return row;
  }

  @Patch("dict-types/:id")
  @RequirePermissions(PERMS.dictEdit)
  async updateType(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(typePatch, body);
    await this.ownType(id, auth.tenantId);
    return this.tenantDb.db.dictType.update({ where: { id }, data: { ...input, updatedBy: auth.accountId } });
  }

  @Delete("dict-types/:id")
  @RequirePermissions(PERMS.dictRemove)
  async removeType(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const t = await this.ownType(id, auth.tenantId);
    await this.tenantDb.transaction(async (tx) => {
      await tx.dictItem.updateMany({ where: { typeId: id }, data: { deletedAt: new Date() } });
      await tx.dictType.update({ where: { id }, data: { deletedAt: new Date(), code: `${t.code}~deleted~${Date.now()}` } });
    });
    await this.audit.record(auth.accountId, "dict.delete", "dictType", id, { code: t.code });
    return { id };
  }

  @Get("dict-types/:id/items")
  @RequirePermissions(PERMS.dictList)
  async items(@Param("id", ParseUUIDPipe) id: string) {
    const t = await this.tenantDb.db.dictType.findUnique({ where: { id } });
    if (!t) throw new NotFoundException();
    return this.tenantDb.db.dictItem.findMany({ where: { typeId: id }, orderBy: [{ sort: "asc" }, { value: "asc" }] });
  }

  @Post("dict-types/:id/items")
  @RequirePermissions(PERMS.dictAdd)
  async createItem(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(itemSchema, body);
    // 平台字典也可以追加自己的条目（平台预置的条目仍然只读）
    if (!(await this.tenantDb.db.dictType.findUnique({ where: { id } }))) throw new NotFoundException();
    if (await this.tenantDb.db.dictItem.findFirst({ where: { typeId: id, value: input.value } })) throw new ConflictException("The value already exists in this dictionary");
    try {
      return await this.tenantDb.db.dictItem.create({ data: { tenantId: auth.tenantId, typeId: id, value: input.value, label: input.label, remark: input.remark ?? null, sort: input.sort ?? 0, createdBy: auth.accountId } });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw new ConflictException("The value already exists in this dictionary");
      throw err;
    }
  }

  private async ownItem(id: string, tenantId: string) {
    const item = await this.tenantDb.db.dictItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException();
    if (item.tenantId === null) throw new ForbiddenException("Platform-provided dictionary items are read-only");
    if (item.tenantId !== tenantId) throw new NotFoundException();
    return item;
  }

  @Patch("dict-items/:id")
  @RequirePermissions(PERMS.dictEdit)
  async updateItem(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(itemPatch, body);
    await this.ownItem(id, auth.tenantId);
    return this.tenantDb.db.dictItem.update({ where: { id }, data: { ...input, updatedBy: auth.accountId } });
  }

  @Delete("dict-items/:id")
  @RequirePermissions(PERMS.dictRemove)
  async removeItem(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const item = await this.ownItem(id, auth.tenantId);
    await this.tenantDb.db.dictItem.update({ where: { id }, data: { deletedAt: new Date(), value: `${item.value}~deleted~${Date.now()}` } });
    return { id };
  }

  /** 给下拉框用：某个字典的启用条目（带翻译键）。 */
  @Get("dicts/:code")
  @AnyAuthenticated()
  async byCode(@Param("code") code: string) {
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(code)) throw new BadRequestException("Bad dictionary code");
    const type = await this.tenantDb.db.dictType.findFirst({ where: { code, status: true } });
    if (!type) throw new NotFoundException();
    const items = await this.tenantDb.db.dictItem.findMany({ where: { typeId: type.id, status: true }, orderBy: [{ sort: "asc" }, { value: "asc" }] });
    return { code: type.code, items: items.map((i) => ({ value: i.value, label: i.label, labelKey: i.labelKey })) };
  }

  /** 学生门户用的同一个读取接口（门户的请求都走 /api/portal/*）。 */
  @Get("portal/dicts/:code")
  @AnyAuthenticated()
  async byCodeForPortal(@Param("code") code: string) {
    return this.byCode(code);
  }
}
