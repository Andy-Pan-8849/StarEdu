// 教职员工接口。列表/详情走数据范围；内置租户管理员只看得到基础信息（教职员工），敏感信息要权限且在"非基础"范围内。
import { Body, Controller, ForbiddenException, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, paging, parse } from "../common/http";
import { withScope } from "../data-scope/scope-filter";
import { toCsv } from "./csv";
import { parseDay } from "./effective";
import { HrAccess, PERSON_SCOPE } from "./hr-access.service";
import { StaffService } from "./staff.service";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => parseDay(v) !== null).transform((v) => parseDay(v) as Date);
const assignment = z.object({ deptId: z.string().uuid(), postId: z.string().uuid().nullable().optional(), isPrimary: z.boolean().optional(), startDate: day.optional() });
const createSchema = z.object({
  personId: z.string().uuid().optional(),
  fullName: z.string().trim().min(1).max(200).optional(),
  workEmail: z.string().email().max(200).optional(),
  idNumber: z.string().trim().max(50).optional(),
  employeeNo: z.string().regex(/^[A-Za-z0-9_-]{1,30}$/).optional(),
  hireDate: day,
  employmentType: z.enum(["full_time", "part_time"]).optional(),
  assignments: z.array(assignment).max(10).optional(),
});
const patchSchema = z.object({ employmentType: z.enum(["full_time", "part_time"]).optional(), hireDate: day.optional() }).strict();
const transferSchema = z.object({ fromAssignmentId: z.string().uuid(), deptId: z.string().uuid(), postId: z.string().uuid().nullable().optional(), effectiveDate: day.optional() });
const endSchema = z.object({ status: z.enum(["left", "on_leave"]), effectiveDate: day.optional() });
const endAssignmentSchema = z.object({ endDate: day.optional() });

@Controller("api/staff")
export class StaffController {
  constructor(
    private readonly staff: StaffService,
    private readonly hr: HrAccess,
  ) {}

  private async scoped(auth: AuthContext, id: string, perm: string) {
    const scope = await this.hr.scope(auth, perm);
    const row = await this.hr.tenantDb.db.person.findFirst({ where: withScope({ id, staff: { isNot: null } }, scope, PERSON_SCOPE) });
    if (!row) throw new NotFoundException();
    return { scope, row };
  }

  private async list(auth: AuthContext, query: { page?: string; size?: string; q?: string }) {
    const scope = await this.hr.scope(auth, PERMS.hrStaffList);
    const q = query.q?.trim();
    const base = { staff: { isNot: null }, ...(q ? { OR: [{ fullName: { contains: q, mode: "insensitive" as const } }, { workEmail: { contains: q, mode: "insensitive" as const } }, { staff: { employeeNo: { contains: q, mode: "insensitive" as const } } }] } : {}) };
    return this.hr.tenantDb.db.person.findMany({ where: withScope(base, scope, PERSON_SCOPE), orderBy: { fullName: "asc" }, ...paging(query) });
  }

  @Get()
  @RequirePermissions(PERMS.hrStaffList)
  async index(@Auth() auth: AuthContext, @Query() query: { page?: string; size?: string; q?: string }) {
    const rows = await this.list(auth, query);
    const assignments = await this.staff.assignmentsOf(rows.map((r) => r.id));
    const profiles = rows.length ? await this.hr.tenantDb.db.staffProfile.findMany({ where: { personId: { in: rows.map((r) => r.id) } } }) : [];
    return rows.map((r) => {
      const p = profiles.find((x) => x.personId === r.id);
      const mine = (assignments.get(r.id) ?? []).filter((a) => a.current);
      return { id: r.id, tenantId: r.tenantId, fullName: r.fullName, workEmail: r.workEmail, employeeNo: p?.employeeNo ?? null, status: p?.status ?? null, hireDate: p?.hireDate.toISOString().slice(0, 10) ?? null, assignments: mine, campuses: [...new Set(mine.map((a) => (a.campus as { name: string } | null)?.name).filter(Boolean))] };
    });
  }

  /** 导出当前范围内的教职员工基础信息（CSV）。不含敏感信息。 */
  @Get("export")
  @RequirePermissions(PERMS.hrStaffList)
  async export(@Auth() auth: AuthContext, @Res() res: Response) {
    const rows = await this.index(auth, { page: "1", size: "100" });
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", 'attachment; filename="staff.csv"');
    res.send(toCsv(["employee_no", "name", "work_email", "status", "hire_date", "campuses"], rows.map((r) => [r.employeeNo, r.fullName, r.workEmail, r.status, r.hireDate, r.campuses.join("; ")])));
  }

  @Get(":id")
  @RequirePermissions(PERMS.hrStaffList)
  async get(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const { row } = await this.scoped(auth, id, PERMS.hrStaffList);
    const scope = await this.hr.scope(auth, PERMS.hrPersonSensitive);
    const sensitive = auth.authz.perms.includes(PERMS.hrPersonSensitive) && (await this.hr.inFullScope(scope, id));
    return this.staff.view(row.id, { sensitive });
  }

  @Post()
  @RequirePermissions(PERMS.hrStaffAdd)
  async create(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(createSchema, body);
    if (input.idNumber) {
      // 证件号是敏感信息：要权限，并且操作者的范围不能只有"教职员工基础信息"（内置租户管理员就是这样）
      const sc = await this.hr.scope(auth, PERMS.hrPersonSensitive);
      if (!auth.authz.perms.includes(PERMS.hrPersonSensitive) || !(sc.all || sc.deptIds.length > 0 || sc.selfPersonId)) throw new ForbiddenException("You may not set sensitive information");
    }
    const r = await this.staff.create(auth, PERMS.hrStaffAdd, input);
    return { personId: r.personId, employeeNo: r.profile.employeeNo };
  }

  @Patch(":id")
  @RequirePermissions(PERMS.hrStaffEdit)
  async update(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(patchSchema, body);
    await this.scoped(auth, id, PERMS.hrStaffEdit);
    await this.hr.tenantDb.db.staffProfile.updateMany({ where: { personId: id }, data: { ...input, updatedBy: auth.accountId } });
    return this.staff.view(id);
  }

  @Post(":id/assignments")
  @RequirePermissions(PERMS.hrStaffAssign)
  async assign(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    await this.scoped(auth, id, PERMS.hrStaffAssign);
    return this.staff.addAssignment(auth, id, parse(assignment, body));
  }

  @Post(":id/transfer")
  @RequirePermissions(PERMS.hrStaffAssign)
  async transfer(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    await this.scoped(auth, id, PERMS.hrStaffAssign);
    return this.staff.transfer(auth, id, parse(transferSchema, body));
  }

  @Delete(":id/assignments/:assignmentId")
  @RequirePermissions(PERMS.hrStaffAssign)
  async endAssignment(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Param("assignmentId", ParseUUIDPipe) assignmentId: string, @Body() body: unknown) {
    await this.scoped(auth, id, PERMS.hrStaffAssign);
    return this.staff.endAssignment(auth, id, assignmentId, parse(endAssignmentSchema, body ?? {}).endDate);
  }

  @Post(":id/end")
  @RequirePermissions(PERMS.hrStaffEnd)
  async end(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    await this.scoped(auth, id, PERMS.hrStaffEnd);
    return this.staff.endEmployment(auth, id, parse(endSchema, body));
  }

  @Post(":id/reinstate")
  @RequirePermissions(PERMS.hrStaffEnd)
  async reinstate(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    await this.scoped(auth, id, PERMS.hrStaffEnd);
    return this.staff.reinstate(auth, id);
  }
}
