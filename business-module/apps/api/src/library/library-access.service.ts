// 文档库的访问级别：对一个用户、一个文件夹，最终是 none / view / edit / manage。
//   - 有效授权 = 文件夹自己的授权 + （"继承上级授权"为真时）上级的有效授权，递归；机密文件夹不继承；
//   - 授权对象：全体成员（含学生）/ 全体员工 / 部门（可含下级）/ 角色 / 用户；已过期的授权不算；
//   - 一个人命中多条授权取最高级别（并集）；没有"拒绝"；
//   - 数据权限集不用于文档库；内置管理员也没有任何特权：机密文件夹要先给自己授权（并留痕）。
//   - 最终权限 = 菜单按钮上的操作权限 ∧ 这里的级别，两个条件由接口一起检查。
import { Injectable } from "@nestjs/common";
import type { AuthContext } from "../auth/tenant-token.guard";
import { effectiveWhere } from "../hr/effective";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";

export type Level = "none" | "view" | "edit" | "manage";
const RANK: Record<Level, number> = { none: 0, view: 1, edit: 2, manage: 3 };
export const atLeast = (have: Level, need: Level): boolean => RANK[have] >= RANK[need];
const higher = (a: Level, b: Level): Level => (RANK[a] >= RANK[b] ? a : b);

export interface FolderRow {
  id: string;
  parentId: string | null;
  ancestors: string[];
  name: string;
  ownerDeptId: string | null;
  classification: string;
  inheritAcl: boolean;
  previewOnly: boolean;
  logAccess: boolean;
  createdBy: string | null;
  createdAt: Date;
}

export interface Access {
  folders: Map<string, FolderRow>;
  level: (folderId: string) => Level;
}

@Injectable()
export class LibraryAccess {
  constructor(private readonly tenantDb: TenantPrismaService) {}

  private get db() {
    return this.tenantDb.db;
  }

  /** 这个人在每个文件夹上的级别。文档库规模不大（演示规模），一次读出全部文件夹和授权再算。 */
  async resolve(auth: AuthContext): Promise<Access> {
    const [rows, acl, deptLinks] = await Promise.all([
      this.db.docFolder.findMany({}),
      this.db.docAcl.findMany({ where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } }),
      auth.authz.personId ? this.db.personDept.findMany({ where: { personId: auth.authz.personId, ...effectiveWhere() } }) : Promise.resolve([]),
    ]);
    const person = auth.authz.personId ? await this.db.person.findUnique({ where: { id: auth.authz.personId }, select: { type: true } }) : null;
    const isStaff = person?.type === "staff" && !auth.authz.staffInactive;
    const deptIds = new Set(deptLinks.map((d) => d.deptId));
    const depts = deptIds.size ? await this.db.dept.findMany({ where: { id: { in: [...deptIds] } }, select: { ancestors: true } }) : [];
    const underDept = new Set(depts.flatMap((d) => d.ancestors)); // 我所在部门及其所有上级：授权给"某部门（含下级）"的，我命中
    const roleIds = new Set(auth.authz.roles.map((r) => r.id));
    const folders = new Map(rows.map((r) => [r.id, r as FolderRow]));
    const matches = (a: (typeof acl)[number]): boolean => {
      switch (a.principalType) {
        case "everyone": return true;
        case "all_staff": return isStaff;
        case "user": return a.principalId === auth.accountId;
        case "role": return !!a.principalId && roleIds.has(a.principalId);
        case "dept": return !!a.principalId && (a.includeSub ? underDept.has(a.principalId) : deptIds.has(a.principalId));
        default: return false;
      }
    };
    const own = new Map<string, Level>();
    for (const a of acl) if (matches(a)) own.set(a.folderId, higher(own.get(a.folderId) ?? "none", a.level as Level));
    const memo = new Map<string, Level>();
    const effective = (id: string): Level => {
      const cached = memo.get(id);
      if (cached) return cached;
      const f = folders.get(id);
      if (!f) return "none";
      memo.set(id, "none"); // 防环
      let level: Level = own.get(id) ?? "none";
      if (f.inheritAcl && f.parentId) level = higher(level, effective(f.parentId));
      memo.set(id, level);
      return level;
    };
    return { folders, level: effective };
  }
}
