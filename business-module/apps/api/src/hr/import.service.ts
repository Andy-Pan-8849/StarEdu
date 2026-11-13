// 批量导入（CSV）：校区、教职员工、学生。格式就是样例文件 employees.csv / students.csv / campuses.csv 的列。
//   - 可重复运行（幂等）：按员工编号/学号对账，已有且没变的算"未变"，变了的更新；
//   - 一次只在一个事务里做，任何一行出错都先收集，不出错的行仍然写入（错误行单独报告）；dryRun 只检查不写入；
//   - 校区编号可以用别名映射（样例里的总部叫 BJ，业务模块里总部校区的代码是 HQ：{"BJ":"HQ"}）；
//   - 部门按名称在校区根节点下查找或创建；岗位按职位名称查找或创建。
import { ForbiddenException, Injectable } from "@nestjs/common";
import type { Prisma } from "../generated/prisma";
import type { AuthContext } from "../auth/tenant-token.guard";
import { requireTenant } from "../tenancy/request-scope";
import { parseCsvRecords } from "./csv";
import { parseDay, todayUtc } from "./effective";
import { HrAccess } from "./hr-access.service";

export interface ImportResult {
  created: number;
  updated: number;
  unchanged: number;
  errors: Array<{ row: number; message: string }>;
  /** 被更新的行（行号和变化），方便核对 */
  changes: Array<{ row: number; message: string }>;
  dryRun: boolean;
}

export interface ImportOptions {
  dryRun?: boolean;
  campusAliases?: Record<string, string>;
}

class Rollback extends Error {
  constructor(readonly result: ImportResult) {
    super("rollback");
  }
}

const STUDENT_STATUS: Record<string, "enrolled" | "on_leave" | "graduated" | "withdrawn" | "completed"> = {
  active: "enrolled",
  enrolled: "enrolled",
  on_leave: "on_leave",
  graduated: "graduated",
  withdrawn: "withdrawn",
  completed: "completed",
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "post";

@Injectable()
export class ImportService {
  constructor(private readonly hr: HrAccess) {}

  private async run(opts: ImportOptions, work: (tx: Prisma.TransactionClient, result: ImportResult) => Promise<void>): Promise<ImportResult> {
    const result: ImportResult = { created: 0, updated: 0, unchanged: 0, errors: [], changes: [], dryRun: opts.dryRun === true };
    try {
      await this.hr.tenantDb.transaction(async (tx) => {
        await work(tx, result);
        if (opts.dryRun) throw new Rollback(result);
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    return result;
  }

  /** 批量导入是整体性的操作：要求"全部"数据范围（人事主管、集团层面），分校区的角色不能用。 */
  private async requireAll(auth: AuthContext, perm: string): Promise<void> {
    if ((auth as { system?: boolean }).system) return; // 命令行导入样例数据（pnpm import:sample）：没有登录用户，直接放行
    if (!(await this.hr.scope(auth, perm)).all) throw new ForbiddenException("Bulk import needs the 'all data' scope");
  }

  /** 校区是系统管理类对象（租户管理员也管），不要求业务数据范围。 */
  async importCampuses(auth: AuthContext, _perm: string, csv: string, opts: ImportOptions = {}): Promise<ImportResult> {
    const tenant = requireTenant("import campuses");
    return this.run(opts, async (tx, result) => {
      const existing = new Map((await tx.campus.findMany({})).map((c) => [c.code, c]));
      for (const [i, r] of parseCsvRecords(csv).entries()) {
        const row = i + 2;
        const code = (opts.campusAliases?.[r.campus_id] ?? r.campus_id ?? "").toUpperCase();
        if (!/^[A-Z][A-Z0-9_-]{1,19}$/.test(code) || !r.name) {
          result.errors.push({ row, message: "campus_id and name are required (id: 2-20 uppercase letters or digits)" });
          continue;
        }
        const current = existing.get(code);
        if (current) {
          result.unchanged += 1; // 已有的校区不改名（名称可能被租户改过）
          continue;
        }
        const dept = await tx.dept.create({ data: { tenantId: tenant.tenantId, name: r.name } });
        const created = await tx.campus.create({ data: { tenantId: tenant.tenantId, deptId: dept.id, code, name: r.name, type: "campus", createdBy: auth.accountId } });
        existing.set(code, created);
        result.created += 1;
      }
    });
  }

  private async campusMap(tx: Prisma.TransactionClient) {
    return new Map((await tx.campus.findMany({})).map((c) => [c.code, c]));
  }

  async importStaff(auth: AuthContext, csv: string, opts: ImportOptions = {}): Promise<ImportResult> {
    await this.requireAll(auth, "hr:staff:import");
    const tenant = requireTenant("import staff");
    return this.run(opts, async (tx, result) => {
      const campuses = await this.campusMap(tx);
      const posts = new Map((await tx.post.findMany({})).map((p) => [p.code, p.id]));
      for (const [i, r] of parseCsvRecords(csv).entries()) {
        const row = i + 2;
        const no = r.employee_id;
        const code = (opts.campusAliases?.[r.campus_id] ?? r.campus_id ?? "").toUpperCase();
        const campus = campuses.get(code);
        const hire = parseDay(r.hire_date);
        if (!no || !r.name) result.errors.push({ row, message: "employee_id and name are required" });
        else if (!campus) result.errors.push({ row, message: `unknown campus "${r.campus_id}"` });
        else if (!hire) result.errors.push({ row, message: "hire_date must be YYYY-MM-DD" });
        else {
          const status = r.status === "active" || !r.status ? "active" : "left";
          const profile = await tx.staffProfile.findFirst({ where: { employeeNo: no } });
          if (profile) {
            const person = await tx.person.findUnique({ where: { id: profile.personId } });
            // 同一个人既是员工又是学员时，名字由人事手工维护：导入不改名（否则员工表和学员表会互相改来改去）
            const alsoStudent = !!(await tx.studentProfile.findFirst({ where: { personId: profile.personId } }));
            if ((alsoStudent || person?.fullName === r.name) && profile.status === status) result.unchanged += 1;
            else {
              result.changes.push({ row, message: `${no}: name "${person?.fullName}" → "${r.name}", status ${profile.status} → ${status}` });
              if (!alsoStudent) await tx.person.update({ where: { id: profile.personId }, data: { fullName: r.name } });
              await tx.staffProfile.update({ where: { id: profile.id }, data: { status } });
              result.updated += 1;
            }
            continue;
          }
          // 部门：校区根节点下按名称找或建；岗位：按职位名称找或建
          let deptId = campus.deptId;
          if (r.department) {
            const found = await tx.dept.findFirst({ where: { parentId: campus.deptId, name: r.department } });
            deptId = found?.id ?? (await tx.dept.create({ data: { tenantId: tenant.tenantId, name: r.department, parentId: campus.deptId } })).id;
          }
          let postId: string | null = null;
          if (r.title) {
            const pc = slug(r.title);
            postId = posts.get(pc) ?? (await tx.post.create({ data: { tenantId: tenant.tenantId, code: pc, name: r.title } })).id;
            posts.set(pc, postId);
          }
          const person = await tx.person.create({ data: { tenantId: tenant.tenantId, type: "staff", fullName: r.name, createdBy: auth.accountId } });
          await tx.staffProfile.create({ data: { tenantId: tenant.tenantId, personId: person.id, employeeNo: no, hireDate: hire, status, createdBy: auth.accountId } });
          await tx.personDept.create({ data: { tenantId: tenant.tenantId, personId: person.id, deptId, postId, kind: "staff", isPrimary: true, startDate: hire, endDate: status === "left" ? todayUtc() : null } });
          result.created += 1;
        }
      }
    });
  }

  async importStudents(auth: AuthContext, csv: string, opts: ImportOptions = {}): Promise<ImportResult> {
    await this.requireAll(auth, "hr:student:import");
    const tenant = requireTenant("import students");
    return this.run(opts, async (tx, result) => {
      const campuses = await this.campusMap(tx);
      for (const [i, r] of parseCsvRecords(csv).entries()) {
        const row = i + 2;
        const code = (opts.campusAliases?.[r.campus_id] ?? r.campus_id ?? "").toUpperCase();
        const campus = campuses.get(code);
        const status = STUDENT_STATUS[r.status || "active"];
        if (!r.student_id || !r.name) result.errors.push({ row, message: "student_id and name are required" });
        else if (!campus) result.errors.push({ row, message: `unknown campus "${r.campus_id}"` });
        else if (!status) result.errors.push({ row, message: `unknown status "${r.status}"` });
        else {
          const profile = await tx.studentProfile.findFirst({ where: { studentNo: r.student_id } });
          if (profile) {
            const person = await tx.person.findUnique({ where: { id: profile.personId } });
            const alsoStaff = !!(await tx.staffProfile.findFirst({ where: { personId: profile.personId } }));
            if ((alsoStaff || person?.fullName === r.name) && profile.academicStatus === status && profile.campusId === campus.id) result.unchanged += 1;
            else {
              result.changes.push({ row, message: `${r.student_id}: name "${person?.fullName}" → "${r.name}", status ${profile.academicStatus} → ${status}` });
              if (!alsoStaff) await tx.person.update({ where: { id: profile.personId }, data: { fullName: r.name } });
              await tx.studentProfile.update({ where: { id: profile.id }, data: { academicStatus: status, campusId: campus.id, program: r.program || profile.program, enrollTerm: r.cohort || profile.enrollTerm } });
              result.updated += 1;
            }
            continue;
          }
          const person = await tx.person.create({ data: { tenantId: tenant.tenantId, type: "student", fullName: r.name, createdBy: auth.accountId } });
          await tx.studentProfile.create({ data: { tenantId: tenant.tenantId, personId: person.id, studentNo: r.student_id, campusId: campus.id, program: r.program || null, enrollTerm: r.cohort || null, academicStatus: status, createdBy: auth.accountId } });
          await tx.personDept.create({ data: { tenantId: tenant.tenantId, personId: person.id, deptId: campus.deptId, kind: "student", isPrimary: true, startDate: todayUtc(), endDate: ["graduated", "withdrawn", "completed"].includes(status) ? todayUtc() : null } });
          result.created += 1;
        }
      }
    });
  }
}
