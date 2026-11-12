// 人员（B2 范围：只读列表/详情 + 改姓名和工作邮箱），用来承载数据范围的真实用法；
// 完整的人事档案在 B5。
//   - 列表、详情、修改都走数据范围解析器，按"持有该权限字符的角色"的数据权限集过滤；
//   - 修改时目标行必须在范围内，否则 404（不区分"不存在"和"范围外"，避免探测）；
//   - 内置租户管理员：业务数据范围为"无"，只能看到教职员工（基础信息）。
import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch } from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { DataScopeService } from "../data-scope/data-scope.service";
import { withScope, type ScopeMapping } from "../data-scope/scope-filter";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";

export const PERSON_SCOPE: ScopeMapping = {
  dept: (ids) => ({ depts: { some: { deptId: { in: ids } } } }),
  self: (personId) => ({ id: personId }),
  staffBasic: { type: "staff" },
};

const patchSchema = z.object({ fullName: z.string().trim().min(1).max(200).optional(), workEmail: z.string().email().max(200).nullable().optional() }).strict();

@Controller("api/persons")
export class PersonsController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly scopes: DataScopeService,
  ) {}

  @Get()
  @RequirePermissions(PERMS.hrPersonList)
  async list(@Auth() auth: AuthContext) {
    const scope = await this.scopes.resolve(auth.tenantId, auth.authz, PERMS.hrPersonList);
    return this.tenantDb.db.person.findMany({ where: withScope(undefined, scope, PERSON_SCOPE), include: { depts: true }, orderBy: { fullName: "asc" } });
  }

  @Get(":id")
  @RequirePermissions(PERMS.hrPersonList)
  async get(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const scope = await this.scopes.resolve(auth.tenantId, auth.authz, PERMS.hrPersonList);
    const row = await this.tenantDb.db.person.findFirst({ where: withScope({ id }, scope, PERSON_SCOPE), include: { depts: true } });
    if (!row) throw new NotFoundException();
    return row;
  }

  @Patch(":id")
  @RequirePermissions(PERMS.hrPersonEdit)
  async update(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(patchSchema, body);
    const scope = await this.scopes.resolve(auth.tenantId, auth.authz, PERMS.hrPersonEdit);
    const target = await this.tenantDb.db.person.findFirst({ where: withScope({ id }, scope, PERSON_SCOPE) });
    if (!target) throw new NotFoundException();
    return this.tenantDb.db.person.update({ where: { id }, data: { ...input, updatedBy: auth.accountId } });
  }
}
