// 数据范围解析器：把"账号在当前权限字符下"的数据权限集解析成具体的部门/本人/班级 id。
// 所有列表、详情、写操作都走这里，不允许各接口自己拼。
//   - 只有持有当前接口所需权限字符的角色才参与计算（S1）：别的角色的"全部"不会扩大这个接口的范围；
//   - 多个角色、多个集取并集；没有适用的集 = 看不到数据；
//   - 内置"租户管理员"：业务数据范围为"无"，只带"教职员工基础信息"标记；
//   - 内置"学生"：仅本人 + 本人就读的班级；
//   - 结果按权限版本号缓存（改了角色、数据权限集、任职记录要 bump）。
import { Inject, Injectable, Optional } from "@nestjs/common";
import { RedisService } from "../redis/redis.service";
import { Authz, AuthzService } from "../rbac/authz.service";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { EMPTY_SCOPE, unionScopes, type ResolvedScope } from "./scope-filter";

/** 班级成员关系由教学模块（B6）提供；B2 没有班级，默认返回空。 */
export const CLASS_MEMBERSHIP = Symbol("CLASS_MEMBERSHIP");
export interface ClassMembershipProvider {
  /** 这个人任教或就读的班级 id */
  classIdsFor(personId: string): Promise<string[]>;
}

const CACHE_TTL_SECONDS = 3600;

@Injectable()
export class DataScopeService {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly authz: AuthzService,
    private readonly redis: RedisService,
    @Optional() @Inject(CLASS_MEMBERSHIP) private readonly classes?: ClassMembershipProvider,
  ) {}

  async resolve(tenantId: string, auth: Authz, perm: string): Promise<ResolvedScope> {
    const version = await this.authz.version(tenantId);
    const key = `scope:${tenantId}:${auth.accountId}:${perm}`;
    const cached = await this.redis.client.get(key);
    if (cached) {
      const parsed = JSON.parse(cached) as { version: number; scope: ResolvedScope };
      if (parsed.version === version) return parsed.scope;
    }
    const scope = await this.compute(auth, perm);
    await this.redis.client.set(key, JSON.stringify({ version, scope }), "EX", CACHE_TTL_SECONDS);
    return scope;
  }

  private async compute(auth: Authz, perm: string): Promise<ResolvedScope> {
    const db = this.tenantDb.db;
    const roles = auth.roles.filter((r) => r.perms.includes(perm));
    if (roles.length === 0) return EMPTY_SCOPE;

    const parts: ResolvedScope[] = [];
    const personDepts = auth.personId ? (await db.personDept.findMany({ where: { personId: auth.personId } })).map((p) => p.deptId) : [];
    const expand = async (deptIds: string[]): Promise<string[]> => {
      if (deptIds.length === 0) return [];
      const rows = await db.dept.findMany({ where: { ancestors: { hasSome: deptIds } }, select: { id: true } });
      return rows.map((r) => r.id);
    };
    const classIds = async (): Promise<string[]> => (auth.personId && this.classes ? this.classes.classIdsFor(auth.personId) : []);

    const customRoleIds: string[] = [];
    for (const role of roles) {
      if (role.kind === "tenant_admin") parts.push({ ...EMPTY_SCOPE, staffBasic: true });
      else if (role.kind === "student") {
        parts.push({ ...EMPTY_SCOPE, selfPersonId: auth.personId, classIds: await classIds() });
      } else customRoleIds.push(role.id);
    }

    if (customRoleIds.length > 0) {
      const links = await db.roleDataScope.findMany({ where: { roleId: { in: customRoleIds } } });
      const sets = links.length ? await db.dataScopeSet.findMany({ where: { id: { in: [...new Set(links.map((l) => l.setId))] } } }) : [];
      for (const set of sets) {
        switch (set.kind) {
          case "all":
            parts.push({ ...EMPTY_SCOPE, all: true });
            break;
          case "own_dept":
            parts.push({ ...EMPTY_SCOPE, deptIds: personDepts });
            break;
          case "own_dept_tree":
            parts.push({ ...EMPTY_SCOPE, deptIds: await expand(personDepts) });
            break;
          case "self":
            parts.push({ ...EMPTY_SCOPE, selfPersonId: auth.personId });
            break;
          case "own_classes":
            parts.push({ ...EMPTY_SCOPE, classIds: await classIds() });
            break;
          case "custom": {
            const nodes = await db.dataScopeSetNode.findMany({ where: { setId: set.id } });
            const direct = nodes.filter((n) => !n.includeChildren).map((n) => n.deptId);
            const tree = await expand(nodes.filter((n) => n.includeChildren).map((n) => n.deptId));
            parts.push({ ...EMPTY_SCOPE, deptIds: [...direct, ...tree] });
            break;
          }
        }
      }
    }
    return unionScopes(parts);
  }
}
