// 数据权限集管理：内置五种（平台提供，只读）+ 租户自定义（在组织树上勾选节点，可含下级）。
// 节点里的部门 id 必须属于本租户（外键不受行级安全约束，所以这里先校验）。
import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { AuditService } from "../audit/audit.service";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { assertVisible } from "../tenancy/owned";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { AuthzService } from "./authz.service";

const bodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  nodes: z.array(z.object({ deptId: z.string().uuid(), includeChildren: z.boolean().default(true) })).min(1).max(500),
});

@Controller("api/data-scope-sets")
export class DataScopeSetsController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions(PERMS.dataScopeList)
  async list() {
    const db = this.tenantDb.db;
    const sets = await db.dataScopeSet.findMany({ orderBy: [{ kind: "asc" }, { name: "asc" }] });
    const nodes = await db.dataScopeSetNode.findMany({});
    return sets.map((s) => ({
      ...s,
      platformProvided: s.tenantId === null,
      nodes: nodes.filter((n) => n.setId === s.id).map((n) => ({ deptId: n.deptId, includeChildren: n.includeChildren })),
    }));
  }

  private async ownCustom(id: string, tenantId: string) {
    const set = await this.tenantDb.db.dataScopeSet.findUnique({ where: { id } });
    if (!set) throw new NotFoundException();
    if (set.tenantId === null) throw new ForbiddenException("Built-in data scopes are read-only");
    if (set.tenantId !== tenantId) throw new NotFoundException();
    return set;
  }

  @Post()
  @RequirePermissions(PERMS.dataScopeAdd)
  async create(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(bodySchema, body);
    const db = this.tenantDb.db;
    await assertVisible(db.dept, input.nodes.map((n) => n.deptId), "department");
    const set = await this.tenantDb.transaction(async (tx) => {
      const row = await tx.dataScopeSet.create({
        data: { tenantId: auth.tenantId, code: `custom-${randomBytes(4).toString("hex")}`, name: input.name, kind: "custom", createdBy: auth.accountId },
      });
      await tx.dataScopeSetNode.createMany({ data: dedupe(input.nodes).map((n) => ({ tenantId: auth.tenantId, setId: row.id, ...n })) });
      return row;
    });
    await this.audit.record(auth.accountId, "dataScope.create", "dataScopeSet", set.id, { name: set.name, nodes: input.nodes.length });
    return set;
  }

  @Put(":id")
  @RequirePermissions(PERMS.dataScopeEdit)
  async update(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(bodySchema, body);
    await this.ownCustom(id, auth.tenantId);
    await assertVisible(this.tenantDb.db.dept, input.nodes.map((n) => n.deptId), "department");
    await this.tenantDb.transaction(async (tx) => {
      await tx.dataScopeSet.update({ where: { id }, data: { name: input.name, updatedBy: auth.accountId } });
      await tx.dataScopeSetNode.deleteMany({ where: { setId: id } });
      await tx.dataScopeSetNode.createMany({ data: dedupe(input.nodes).map((n) => ({ tenantId: auth.tenantId, setId: id, ...n })) });
    });
    await this.authz.bump(auth.tenantId);
    await this.audit.record(auth.accountId, "dataScope.update", "dataScopeSet", id, { nodes: input.nodes.length });
    return { id };
  }

  @Delete(":id")
  @RequirePermissions(PERMS.dataScopeRemove)
  async remove(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const set = await this.ownCustom(id, auth.tenantId);
    const db = this.tenantDb.db;
    if ((await db.roleDataScope.count({ where: { setId: id } })) > 0) throw new ConflictException("The data scope is still used by roles");
    await this.tenantDb.transaction(async (tx) => {
      await tx.dataScopeSetNode.deleteMany({ where: { setId: id } });
      await tx.dataScopeSet.update({ where: { id }, data: { deletedAt: new Date(), code: `${set.code}~deleted~${Date.now()}`, updatedBy: auth.accountId } });
    });
    await this.authz.bump(auth.tenantId);
    await this.audit.record(auth.accountId, "dataScope.delete", "dataScopeSet", id, { name: set.name });
    return { id };
  }
}

function dedupe(nodes: Array<{ deptId: string; includeChildren: boolean }>) {
  if (nodes.length === 0) throw new BadRequestException("At least one node is required");
  return [...new Map(nodes.map((n) => [n.deptId, n])).values()];
}
