// 教职员工：档案 + 任职记录（多条、主/兼任、调岗保留历史）、离职（立即或按生效日期）。
//   离职：所有有效任职结束、档案状态变更、权限立即收回（管理后台）、Keycloak 会话和在线会话被结束；
//   未来的生效日期由定时任务 staff.apply-effective 到点切换。重新入职 = 在原档案上恢复在职并新增任职。
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { realmName } from "@staredu/shared";
import { AuditService } from "../audit/audit.service";
import { SessionStore } from "../auth/session-store";
import type { AuthContext } from "../auth/tenant-token.guard";
import { KeycloakService } from "../keycloak/keycloak.service";
import { AuthzService } from "../rbac/authz.service";
import { requireTenant } from "../tenancy/request-scope";
import { dayBefore, effectiveWhere, todayUtc } from "./effective";
import { basicPerson, HrAccess, sensitivePerson } from "./hr-access.service";
import type { StaffStatus } from "../generated/prisma";

export interface AssignmentInput {
  deptId: string;
  postId?: string | null;
  isPrimary?: boolean;
  startDate?: Date;
}

export interface CreateStaffInput {
  personId?: string;
  fullName?: string;
  workEmail?: string;
  idNumber?: string;
  employeeNo?: string;
  hireDate: Date;
  employmentType?: string;
  assignments?: AssignmentInput[];
}

@Injectable()
export class StaffService {
  constructor(
    private readonly hr: HrAccess,
    private readonly audit: AuditService,
    private readonly authz: AuthzService,
    private readonly keycloak: KeycloakService,
    private readonly sessions: SessionStore,
  ) {}

  private get db() {
    return this.hr.tenantDb.db;
  }

  /** 按邮箱/证件号找重复的自然人（不分大小写）。 */
  async findDuplicate(workEmail?: string | null, idNumber?: string | null) {
    const or = [
      ...(workEmail ? [{ workEmail: { equals: workEmail, mode: "insensitive" as const } }] : []),
      ...(idNumber ? [{ idNumber }] : []),
    ];
    if (or.length === 0) return null;
    const p = await this.db.person.findFirst({ where: { OR: or } });
    if (!p) return null;
    const [staff, student] = await Promise.all([this.db.staffProfile.findFirst({ where: { personId: p.id } }), this.db.studentProfile.findFirst({ where: { personId: p.id } })]);
    return { id: p.id, fullName: p.fullName, hasStaff: !!staff || p.type === "staff", hasStudent: !!student || p.type === "student" };
  }

  private async nextEmployeeNo(): Promise<string> {
    const all = await this.db.staffProfile.findMany({ select: { employeeNo: true } });
    const max = all.map((s) => /^E(\d+)$/.exec(s.employeeNo)?.[1]).filter((n): n is string => !!n).reduce((m, n) => Math.max(m, Number(n)), 0);
    return `E${String(max + 1).padStart(4, "0")}`;
  }

  async create(auth: AuthContext, scopePerm: string, input: CreateStaffInput) {
    const tenant = requireTenant("create staff");
    const scope = await this.hr.scope(auth, scopePerm);
    let personId = input.personId;
    if (personId) {
      const person = await this.hr.person(personId);
      if (await this.db.staffProfile.findFirst({ where: { personId } })) throw new ConflictException("This person already has a staff profile");
      personId = person.id;
    } else {
      if (!input.fullName) throw new BadRequestException("A name is required");
      const dup = await this.findDuplicate(input.workEmail, input.idNumber);
      if (dup) throw new ConflictException({ code: "DUPLICATE_PERSON", message: "A person with this e-mail or ID number already exists; add the staff profile to that person instead", existing: dup });
    }
    for (const a of input.assignments ?? []) {
      await this.hr.validateNewPlacement(a.deptId, a.postId); // 先确认关联 id 属于本租户，再看数据范围
      this.hr.assertDeptInScope(scope, a.deptId);
    }
    const employeeNo = input.employeeNo ?? (await this.nextEmployeeNo());
    try {
      const result = await this.hr.tenantDb.transaction(async (tx) => {
        const id = personId ?? (await tx.person.create({ data: { tenantId: tenant.tenantId, type: "staff", fullName: input.fullName as string, workEmail: input.workEmail ?? null, idNumber: input.idNumber ?? null, createdBy: auth.accountId } })).id;
        const profile = await tx.staffProfile.create({ data: { tenantId: tenant.tenantId, personId: id, employeeNo, hireDate: input.hireDate, employmentType: input.employmentType ?? "full_time", createdBy: auth.accountId } });
        for (const [i, a] of (input.assignments ?? []).entries()) {
          await tx.personDept.create({ data: { tenantId: tenant.tenantId, personId: id, deptId: a.deptId, postId: a.postId ?? null, kind: "staff", isPrimary: a.isPrimary ?? i === 0, startDate: a.startDate ?? input.hireDate } });
        }
        return { personId: id, profile };
      });
      await this.authz.bump(auth.tenantId);
      await this.audit.record(auth.accountId, "staff.create", "person", result.personId, { employeeNo });
      return result;
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw new ConflictException("Employee number, e-mail or ID number already exists");
      throw err;
    }
  }

  async assignmentsOf(personIds: string[]) {
    if (personIds.length === 0) return new Map<string, Array<Record<string, unknown>>>();
    const rows = await this.db.personDept.findMany({ where: { personId: { in: personIds }, kind: "staff" }, orderBy: { startDate: "desc" } });
    const depts = new Map((await this.db.dept.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.deptId))] } }, select: { id: true, name: true } })).map((d) => [d.id, d.name]));
    const posts = new Map((await this.db.post.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => (r.postId ? [r.postId] : [])))] } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
    const campuses = await this.hr.campusesFor(rows.map((r) => r.deptId));
    const today = todayUtc();
    const out = new Map<string, Array<Record<string, unknown>>>();
    for (const r of rows) {
      const current = r.startDate <= today && (!r.endDate || r.endDate >= today);
      const item = { id: r.id, deptId: r.deptId, deptName: depts.get(r.deptId) ?? null, postId: r.postId, postName: r.postId ? (posts.get(r.postId) ?? null) : null, isPrimary: r.isPrimary, startDate: r.startDate.toISOString().slice(0, 10), endDate: r.endDate?.toISOString().slice(0, 10) ?? null, current, campus: campuses.get(r.deptId) ?? null };
      out.set(r.personId, [...(out.get(r.personId) ?? []), item]);
    }
    return out;
  }

  async view(personId: string, opts: { sensitive?: boolean } = {}) {
    const p = await this.hr.person(personId);
    const profile = await this.db.staffProfile.findFirst({ where: { personId } });
    const assignments = (await this.assignmentsOf([personId])).get(personId) ?? [];
    const campuses = [...new Map(assignments.filter((a) => a.current && a.campus).map((a) => [(a.campus as { id: string }).id, a.campus])).values()];
    return {
      ...basicPerson(p),
      staff: profile && { employeeNo: profile.employeeNo, hireDate: profile.hireDate.toISOString().slice(0, 10), status: profile.status, employmentType: profile.employmentType, pendingStatus: profile.pendingStatus, pendingEffectiveOn: profile.pendingEffectiveOn?.toISOString().slice(0, 10) ?? null },
      assignments,
      campuses, // 教职员工的校区由当前任职部门推算，只读
      ...(opts.sensitive ? { sensitive: sensitivePerson(p) } : {}),
    };
  }

  // ---- 任职 ----
  async addAssignment(auth: AuthContext, personId: string, input: AssignmentInput) {
    const tenant = requireTenant("add assignment");
    await this.requireStaff(personId);
    const scope = await this.hr.scope(auth, "hr:staff:assign");
    await this.hr.validateNewPlacement(input.deptId, input.postId);
    this.hr.assertDeptInScope(scope, input.deptId);
    await this.hr.tenantDb.transaction(async (tx) => {
      if (input.isPrimary) await tx.personDept.updateMany({ where: { personId, kind: "staff", isPrimary: true }, data: { isPrimary: false } });
      await tx.personDept.create({ data: { tenantId: tenant.tenantId, personId, deptId: input.deptId, postId: input.postId ?? null, kind: "staff", isPrimary: input.isPrimary ?? false, startDate: input.startDate ?? todayUtc() } });
    });
    await this.authz.bump(auth.tenantId);
    await this.audit.record(auth.accountId, "staff.assign", "person", personId, { deptId: input.deptId });
    return this.view(personId);
  }

  /** 调岗：旧任职填结束日期（生效日前一天），新增一条从生效日开始的任职；历史保留。 */
  async transfer(auth: AuthContext, personId: string, input: { fromAssignmentId: string; deptId: string; postId?: string | null; effectiveDate?: Date }) {
    const tenant = requireTenant("transfer staff");
    await this.requireStaff(personId);
    const scope = await this.hr.scope(auth, "hr:staff:assign");
    const from = await this.db.personDept.findFirst({ where: { id: input.fromAssignmentId, personId, kind: "staff" } });
    if (!from) throw new NotFoundException();
    await this.hr.validateNewPlacement(input.deptId, input.postId);
    this.hr.assertDeptInScope(scope, from.deptId);
    this.hr.assertDeptInScope(scope, input.deptId);
    const effective = input.effectiveDate ?? todayUtc();
    const lastDay = new Date(effective.getTime() - 864e5);
    if (from.endDate && from.endDate < effective) throw new ConflictException("The assignment has already ended");
    await this.hr.tenantDb.transaction(async (tx) => {
      await tx.personDept.update({ where: { id: from.id }, data: { endDate: lastDay < from.startDate ? from.startDate : lastDay, isPrimary: false } });
      await tx.personDept.create({ data: { tenantId: tenant.tenantId, personId, deptId: input.deptId, postId: input.postId ?? null, kind: "staff", isPrimary: from.isPrimary, startDate: effective } });
    });
    await this.authz.bump(auth.tenantId); // 部门变了，数据范围随之变化
    await this.audit.record(auth.accountId, "staff.transfer", "person", personId, { from: from.deptId, to: input.deptId, effective: effective.toISOString().slice(0, 10) });
    return this.view(personId);
  }

  async endAssignment(auth: AuthContext, personId: string, assignmentId: string, endDate?: Date) {
    await this.requireStaff(personId);
    const scope = await this.hr.scope(auth, "hr:staff:assign");
    const row = await this.db.personDept.findFirst({ where: { id: assignmentId, personId, kind: "staff" } });
    if (!row) throw new NotFoundException();
    this.hr.assertDeptInScope(scope, row.deptId);
    await this.db.personDept.update({ where: { id: assignmentId }, data: { endDate: endDate ?? todayUtc(), isPrimary: false } });
    await this.authz.bump(auth.tenantId);
    await this.audit.record(auth.accountId, "staff.endAssignment", "person", personId, { assignmentId });
    return this.view(personId);
  }

  private async requireStaff(personId: string) {
    const profile = await this.db.staffProfile.findFirst({ where: { personId } });
    if (!profile) throw new NotFoundException("This person has no staff profile");
    return profile;
  }

  // ---- 离职 / 停薪留职 / 恢复 ----
  /** 离职或停薪留职。生效日期今天或更早：立即生效；将来：记下来，由定时任务到点切换。 */
  async endEmployment(auth: AuthContext, personId: string, input: { status: Extract<StaffStatus, "left" | "on_leave">; effectiveDate?: Date }) {
    const profile = await this.requireStaff(personId);
    const scope = await this.hr.scope(auth, "hr:staff:end");
    if (!scope.all && !(await this.hr.inFullScope(scope, personId)) && !scope.staffBasic) throw new ForbiddenException("This person is outside your data scope");
    if (profile.status === "left") throw new ConflictException("The employment has already ended");
    const account = await this.db.account.findFirst({ where: { personId } });
    if (account?.isBuiltinAdmin) throw new ForbiddenException("The built-in administrator cannot be ended");
    const effective = input.effectiveDate ?? todayUtc();
    if (effective > todayUtc()) {
      await this.db.staffProfile.update({ where: { id: profile.id }, data: { pendingStatus: input.status, pendingEffectiveOn: effective, updatedBy: auth.accountId } });
      await this.audit.record(auth.accountId, "staff.endScheduled", "person", personId, { status: input.status, effective: effective.toISOString().slice(0, 10) });
      return { ...(await this.view(personId)), warnings: [] as string[] };
    }
    await this.applyStatus(personId, input.status, effective, auth.accountId);
    return { ...(await this.view(personId)), warnings: await this.classWarnings(personId) };
  }

  /** 带班教师离职保存前的提示：仍带的班级清单（教学模块 B6 之后回填，现在没有班级）。 */
  async classWarnings(personId: string): Promise<string[]> {
    const sections = await this.db.section.findMany({ where: { instructors: { some: { personId } }, status: { in: ["open", "in_progress"] }, term: { status: { not: "ended" } } }, select: { name: true } });
    return sections.map((s) => `Still teaching ${s.name}: hand the class over`);
  }

  /** 把状态真正切换：结束有效任职、改档案状态、收回权限、结束会话。 */
  async applyStatus(personId: string, status: StaffStatus, effective: Date, actorId: string | null) {
    const tenant = requireTenant("apply staff status");
    await this.hr.tenantDb.transaction(async (tx) => {
      await tx.staffProfile.updateMany({ where: { personId }, data: { status, pendingStatus: null, pendingEffectiveOn: null, updatedBy: actorId } });
      if (status !== "active") await tx.personDept.updateMany({ where: { personId, kind: "staff", OR: [{ endDate: null }, { endDate: { gt: effective } }] }, data: { endDate: dayBefore(effective), isPrimary: false } });
    });
    await this.authz.bump(tenant.tenantId); // 管理后台权限立即收回（见 AuthzService 的 staffInactive）
    if (status !== "active") await this.revokeSessions(personId);
    await this.audit.record(actorId, "staff.status", "person", personId, { status, effective: effective.toISOString().slice(0, 10) });
  }

  /** 撤销这个人的所有登录会话：Keycloak 会话 + 在线记录进拒绝名单。 */
  private async revokeSessions(personId: string) {
    const tenant = requireTenant("revoke sessions");
    const account = await this.db.account.findFirst({ where: { personId } });
    if (!account) return;
    const realm = realmName("tenant", tenant.code);
    for (const s of await this.sessions.list(tenant.tenantId)) {
      if (s.accountId === account.id) {
        await this.sessions.deny(realm, s.sid);
        await this.sessions.remove(tenant.tenantId, s.sid);
      }
    }
    if (account.keycloakUserId) {
      try {
        await (await this.keycloak.client()).logoutUser(realm, account.keycloakUserId);
      } catch {
        /* 权限已经收回，令牌下一个请求就被拒；刷新令牌随会话过期 */
      }
    }
  }

  /** 重新入职：在原档案上恢复"在职"；任职要另外新增。 */
  async reinstate(auth: AuthContext, personId: string) {
    const profile = await this.requireStaff(personId);
    if (profile.status === "active") throw new ConflictException("The person is already employed");
    await this.applyStatus(personId, "active", todayUtc(), auth.accountId);
    return this.view(personId);
  }

  /** 定时任务：到了生效日期的离职/停薪留职切换。必须在租户上下文里调用；返回处理人数。 */
  async applyDue(): Promise<number> {
    const today = todayUtc();
    const due = await this.db.staffProfile.findMany({ where: { pendingEffectiveOn: { lte: today }, pendingStatus: { not: null } } });
    for (const p of due) await this.applyStatus(p.personId, p.pendingStatus as StaffStatus, p.pendingEffectiveOn as Date, null);
    return due.length;
  }

  currentAssignmentsWhere() {
    return effectiveWhere();
  }
}
