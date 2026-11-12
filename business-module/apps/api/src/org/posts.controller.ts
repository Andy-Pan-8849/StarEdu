// 岗位：职位名称目录（不带权限）；任职记录在 B5。
import { Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { AuditService } from "../audit/audit.service";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";

const createSchema = z.object({ code: z.string().regex(/^[a-z][a-z0-9_-]{1,40}$/), name: z.string().trim().min(1).max(100), sort: z.number().int().min(0).max(10000).optional() });
const patchSchema = z.object({ name: z.string().trim().min(1).max(100).optional(), sort: z.number().int().min(0).max(10000).optional(), status: z.boolean().optional() }).strict();

@Controller("api/posts")
export class PostsController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions(PERMS.postList)
  list() {
    return this.tenantDb.db.post.findMany({ orderBy: [{ sort: "asc" }, { code: "asc" }] });
  }

  @Get(":id")
  @RequirePermissions(PERMS.postList)
  async get(@Param("id", ParseUUIDPipe) id: string) {
    const row = await this.tenantDb.db.post.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    return row;
  }

  @Post()
  @RequirePermissions(PERMS.postAdd)
  async create(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(createSchema, body);
    try {
      const row = await this.tenantDb.db.post.create({ data: { tenantId: auth.tenantId, code: input.code, name: input.name, sort: input.sort ?? 0, createdBy: auth.accountId } });
      await this.audit.record(auth.accountId, "post.create", "post", row.id, { code: row.code });
      return row;
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw new ConflictException("Post code already exists");
      throw err;
    }
  }

  @Patch(":id")
  @RequirePermissions(PERMS.postEdit)
  async update(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(patchSchema, body);
    if (!(await this.tenantDb.db.post.findUnique({ where: { id } }))) throw new NotFoundException();
    const row = await this.tenantDb.db.post.update({ where: { id }, data: { ...input, updatedBy: auth.accountId } });
    await this.audit.record(auth.accountId, "post.update", "post", id, input);
    return row;
  }

  /** 软删除，并把编码让出来重新使用。被任职引用时只能停用的规则在 B5（有任职记录后）补上。 */
  @Delete(":id")
  @RequirePermissions(PERMS.postRemove)
  async remove(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const row = await this.tenantDb.db.post.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    await this.tenantDb.db.post.update({ where: { id }, data: { deletedAt: new Date(), code: `${row.code}~deleted~${Date.now()}`, updatedBy: auth.accountId } });
    await this.audit.record(auth.accountId, "post.delete", "post", id, { code: row.code });
    return { id };
  }
}
