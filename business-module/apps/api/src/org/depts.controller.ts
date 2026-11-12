// 部门管理（组织树）。祖先链由数据库触发器维护；
//   - 有任职的人、关联校区、被数据权限集引用的部门不能删除，只能停用；有下级也不能删；
//   - 校区的根节点不能改上级、不能删（要先关闭校区）；
//   - 上级必须是本租户的部门；不能移到自己或后代之下（触发器兜底，这里先转成 400）；
//   - 部门树的变动会让数据范围结果失效，所以改上级、停用、删除都要让权限版本号加一。
import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { AuditService } from "../audit/audit.service";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { AuthzService } from "../rbac/authz.service";
import { assertVisible } from "../tenancy/owned";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";

const createSchema = z.object({ name: z.string().trim().min(1).max(200), parentId: z.string().uuid(), sort: z.number().int().min(0).max(10000).optional() });
const patchSchema = z.object({ name: z.string().trim().min(1).max(200).optional(), parentId: z.string().uuid().optional(), sort: z.number().int().min(0).max(10000).optional(), status: z.boolean().optional() }).strict();

@Controller("api/depts")
export class DeptsController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions(PERMS.deptList)
  list() {
    return this.tenantDb.db.dept.findMany({ orderBy: [{ sort: "asc" }, { name: "asc" }] });
  }

  @Get(":id")
  @RequirePermissions(PERMS.deptList)
  async get(@Param("id", ParseUUIDPipe) id: string) {
    const row = await this.tenantDb.db.dept.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    return row;
  }

  private async dept(id: string) {
    const row = await this.tenantDb.db.dept.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    return row;
  }

  /** 为什么不能删：有下级、有任职、关联了校区、被数据权限集引用。 */
  private async blockers(id: string): Promise<string[]> {
    const db = this.tenantDb.db;
    const reasons: string[] = [];
    if ((await db.dept.count({ where: { parentId: id } })) > 0) reasons.push("it has sub-departments");
    if ((await db.personDept.count({ where: { deptId: id } })) > 0) reasons.push("people are assigned to it");
    if ((await db.campus.count({ where: { deptId: id } })) > 0) reasons.push("it belongs to a campus");
    if ((await db.dataScopeSetNode.count({ where: { deptId: id } })) > 0) reasons.push("a data scope refers to it");
    return reasons;
  }

  @Post()
  @RequirePermissions(PERMS.deptAdd)
  async create(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(createSchema, body);
    await assertVisible(this.tenantDb.db.dept, [input.parentId], "parent department");
    const parent = await this.dept(input.parentId);
    if (!parent.status) throw new BadRequestException("The parent department is disabled");
    const row = await this.tenantDb.db.dept.create({ data: { tenantId: auth.tenantId, name: input.name, parentId: input.parentId, sort: input.sort ?? 0, createdBy: auth.accountId } });
    await this.audit.record(auth.accountId, "dept.create", "dept", row.id, { name: row.name });
    return row;
  }

  @Patch(":id")
  @RequirePermissions(PERMS.deptEdit)
  async update(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(patchSchema, body);
    const dept = await this.dept(id);
    const isCampusRoot = (await this.tenantDb.db.campus.count({ where: { deptId: id } })) > 0;
    if (isCampusRoot && (input.parentId !== undefined || input.name !== undefined)) {
      throw new ForbiddenException("A campus root department is changed through the campus (name) and cannot be moved");
    }
    if (isCampusRoot && input.status !== undefined) throw new ForbiddenException("A campus root department is enabled or disabled through the campus status");
    if (input.parentId !== undefined) {
      if (input.parentId === id) throw new BadRequestException("A department cannot be its own parent");
      await assertVisible(this.tenantDb.db.dept, [input.parentId], "parent department");
      const parent = await this.dept(input.parentId);
      if (parent.ancestors.includes(id)) throw new BadRequestException("A department cannot be moved under its own descendant");
    }
    const row = await this.tenantDb.db.dept.update({ where: { id }, data: { ...input, updatedBy: auth.accountId } });
    if (input.parentId !== undefined || input.status !== undefined) await this.authz.bump(auth.tenantId); // 数据范围随之变化
    await this.audit.record(auth.accountId, "dept.update", "dept", id, { ...input, from: dept.parentId });
    return row;
  }

  @Delete(":id")
  @RequirePermissions(PERMS.deptRemove)
  async remove(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    await this.dept(id);
    const reasons = await this.blockers(id);
    if (reasons.length > 0) throw new ConflictException(`It cannot be deleted (disable it instead): ${reasons.join("; ")}`);
    await this.tenantDb.db.dept.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: auth.accountId } });
    await this.authz.bump(auth.tenantId);
    await this.audit.record(auth.accountId, "dept.delete", "dept", id);
    return { id };
  }
}
