// 人事模块共用：范围解析、校区推算、任职校验。
//   - 读：走数据范围解析器，范围条件由各接口的映射生成；
//   - 写：目标必须在范围内（"本部门"负责人不能给别的校区加任职）；
//   - 内置租户管理员的业务数据范围为"无"，只带"教职员工基础信息"标记：敏感信息、紧急联系人、学生都看不到。
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthContext } from "../auth/tenant-token.guard";
import { DataScopeService } from "../data-scope/data-scope.service";
import { scopeWhere, type ResolvedScope, type ScopeMapping } from "../data-scope/scope-filter";
import { assertVisible } from "../tenancy/owned";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { effectiveWhere } from "./effective";

/** 人员（通用）：按任职/归属的部门、本人、教职员工基础信息。 */
export const PERSON_SCOPE: ScopeMapping = {
  dept: (ids) => ({ depts: { some: { deptId: { in: ids }, ...effectiveWhere() } } }),
  self: (personId) => ({ id: personId }),
  // 旧数据只有 type 没有档案，所以两种都认
  staffBasic: { OR: [{ type: "staff" }, { staff: { isNot: null } }] },
};

/** 敏感信息、紧急联系人：不含"教职员工基础信息"这一项（内置租户管理员因此什么都看不到）。 */
export const PERSON_SCOPE_NO_BASIC: ScopeMapping = { dept: PERSON_SCOPE.dept, self: PERSON_SCOPE.self };

export const STUDENT_SCOPE: ScopeMapping = {
  dept: (ids) => ({ depts: { some: { deptId: { in: ids }, kind: "student", ...effectiveWhere() } } }),
  self: (personId) => ({ id: personId }),
};

export interface CampusRef {
  id: string;
  code: string;
  name: string;
  deptId: string;
  status: string;
}

@Injectable()
export class HrAccess {
  constructor(
    readonly tenantDb: TenantPrismaService,
    private readonly scopes: DataScopeService,
  ) {}

  scope(auth: AuthContext, perm: string): Promise<ResolvedScope> {
    return this.scopes.resolve(auth.tenantId, auth.authz, perm);
  }

  /** 没有"教职员工基础信息"的范围条件：用来判断能不能看敏感信息和紧急联系人。null = 不受限。 */
  noBasicWhere(scope: ResolvedScope) {
    return scopeWhere(scope, PERSON_SCOPE_NO_BASIC);
  }

  /** 目标人员是否在"非基础"范围内（可看敏感信息、紧急联系人）。 */
  async inFullScope(scope: ResolvedScope, personId: string): Promise<boolean> {
    const where = this.noBasicWhere(scope);
    const row = await this.tenantDb.db.person.findFirst({ where: where ? { AND: [{ id: personId }, where] } : { id: personId }, select: { id: true } });
    return !!row;
  }

  /** 写操作：这个部门必须在操作者的数据范围内。 */
  assertDeptInScope(scope: ResolvedScope, deptId: string): void {
    if (scope.all || scope.deptIds.includes(deptId)) return;
    throw new ForbiddenException("This department is outside your data scope");
  }

  /** 部门所属的校区：沿祖先链找到第一个关联了校区的节点。 */
  async campusOfDept(deptId: string): Promise<CampusRef | null> {
    const dept = await this.tenantDb.db.dept.findUnique({ where: { id: deptId } });
    if (!dept) return null;
    const campuses = await this.tenantDb.db.campus.findMany({ where: { deptId: { in: dept.ancestors } } });
    const c = campuses[0];
    return c ? { id: c.id, code: c.code, name: c.name, deptId: c.deptId, status: c.status } : null;
  }

  /** 新增任职/归属时的校验：部门存在且启用；所属校区必须是"正常"（停止新增/已关闭不能再加）；岗位存在且启用。 */
  async validateNewPlacement(deptId: string, postId?: string | null): Promise<void> {
    const db = this.tenantDb.db;
    await assertVisible(db.dept, [deptId], "department");
    const dept = await db.dept.findUnique({ where: { id: deptId } });
    if (!dept || !dept.status) throw new ConflictException("The department is disabled");
    const campus = await this.campusOfDept(deptId);
    if (campus && campus.status !== "normal") throw new ConflictException(`The campus "${campus.name}" does not accept new assignments (${campus.status})`);
    if (postId) {
      await assertVisible(db.post, [postId], "post");
      const post = await db.post.findUnique({ where: { id: postId } });
      if (!post?.status) throw new ConflictException("The post is disabled");
    }
  }

  /** 给一批部门 id 推算校区（人员详情里显示）。 */
  async campusesFor(deptIds: string[]): Promise<Map<string, CampusRef>> {
    const out = new Map<string, CampusRef>();
    if (deptIds.length === 0) return out;
    const db = this.tenantDb.db;
    const depts = await db.dept.findMany({ where: { id: { in: [...new Set(deptIds)] } }, select: { id: true, ancestors: true } });
    const campuses = await db.campus.findMany({});
    for (const d of depts) {
      const c = campuses.find((x) => d.ancestors.includes(x.deptId));
      if (c) out.set(d.id, { id: c.id, code: c.code, name: c.name, deptId: c.deptId, status: c.status });
    }
    return out;
  }

  async person(id: string) {
    const p = await this.tenantDb.db.person.findUnique({ where: { id } });
    if (!p) throw new NotFoundException();
    return p;
  }
}

/** 基础信息（目录级）：不含敏感字段。 */
export function basicPerson(p: { id: string; tenantId: string; type: string; fullName: string; workEmail: string | null }) {
  return { id: p.id, tenantId: p.tenantId, type: p.type, fullName: p.fullName, workEmail: p.workEmail };
}

export function sensitivePerson(p: { birthDate: Date | null; gender: string | null; idNumber: string | null; phone: string | null; address: string | null }) {
  return { birthDate: p.birthDate?.toISOString().slice(0, 10) ?? null, gender: p.gender, idNumber: p.idNumber, phone: p.phone, address: p.address };
}
