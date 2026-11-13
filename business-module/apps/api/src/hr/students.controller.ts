// 学员接口。学员在档案里选校区（同时在组织树上建一条归属，数据范围才能统一计算）；
// 内置租户管理员看不到学生（它的范围里没有学生）。校区"停止新增/已关闭"后不能再新增学员。
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { AuditService } from "../audit/audit.service";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, paging, parse } from "../common/http";
import { withScope } from "../data-scope/scope-filter";
import { AuthzService } from "../rbac/authz.service";
import { requireTenant } from "../tenancy/request-scope";
import { toCsv } from "./csv";
import { dayBefore, todayUtc } from "./effective";
import { basicPerson, HrAccess, sensitivePerson, STUDENT_SCOPE } from "./hr-access.service";
import { StaffService } from "./staff.service";

const STATUSES = ["enrolled", "on_leave", "graduated", "withdrawn", "completed"] as const;
const createSchema = z.object({
  personId: z.string().uuid().optional(),
  fullName: z.string().trim().min(1).max(200).optional(),
  workEmail: z.string().email().max(200).optional(),
  studentNo: z.string().regex(/^[A-Za-z0-9_-]{1,30}$/).optional(),
  campusId: z.string().uuid(),
  enrollTerm: z.string().max(50).optional(),
  degreeType: z.string().max(50).optional(),
  program: z.string().max(100).optional(),
});
const patchSchema = z.object({ academicStatus: z.enum(STATUSES).optional(), campusId: z.string().uuid().optional(), enrollTerm: z.string().max(50).nullable().optional(), degreeType: z.string().max(50).nullable().optional(), program: z.string().max(100).nullable().optional() }).strict();

@Controller("api/students")
export class StudentsController {
  constructor(
    private readonly hr: HrAccess,
    private readonly staff: StaffService,
    private readonly audit: AuditService,
    private readonly authz: AuthzService,
  ) {}

  private get db() {
    return this.hr.tenantDb.db;
  }

  private async scoped(auth: AuthContext, id: string, perm: string) {
    const scope = await this.hr.scope(auth, perm);
    const row = await this.db.person.findFirst({ where: withScope({ id, student: { isNot: null } }, scope, STUDENT_SCOPE) });
    if (!row) throw new NotFoundException();
    return { scope, row };
  }

  private async view(personId: string, sensitive = false) {
    const p = await this.hr.person(personId);
    const profile = await this.db.studentProfile.findFirst({ where: { personId } });
    const campus = profile ? await this.db.campus.findUnique({ where: { id: profile.campusId } }) : null;
    return {
      ...basicPerson(p),
      student: profile && { studentNo: profile.studentNo, campusId: profile.campusId, campusName: campus?.name ?? null, enrollTerm: profile.enrollTerm, academicStatus: profile.academicStatus, degreeType: profile.degreeType, program: profile.program },
      ...(sensitive ? { sensitive: sensitivePerson(p) } : {}),
    };
  }

  @Get()
  @RequirePermissions(PERMS.hrStudentList)
  async index(@Auth() auth: AuthContext, @Query() query: { page?: string; size?: string; q?: string; campusId?: string; status?: string }) {
    const scope = await this.hr.scope(auth, PERMS.hrStudentList);
    const q = query.q?.trim();
    const profileFilter = { ...(query.campusId ? { campusId: query.campusId } : {}), ...(query.status && (STATUSES as readonly string[]).includes(query.status) ? { academicStatus: query.status as (typeof STATUSES)[number] } : {}) };
    const base = {
      student: { is: profileFilter },
      ...(q ? { OR: [{ fullName: { contains: q, mode: "insensitive" as const } }, { student: { studentNo: { contains: q, mode: "insensitive" as const } } }] } : {}),
    };
    const rows = await this.db.person.findMany({ where: withScope(base, scope, STUDENT_SCOPE), orderBy: { fullName: "asc" }, ...paging(query) });
    const profiles = rows.length ? await this.db.studentProfile.findMany({ where: { personId: { in: rows.map((r) => r.id) } } }) : [];
    const campuses = new Map((await this.db.campus.findMany({})).map((c) => [c.id, c.name]));
    return rows.map((r) => {
      const p = profiles.find((x) => x.personId === r.id);
      return { id: r.id, tenantId: r.tenantId, fullName: r.fullName, workEmail: r.workEmail, studentNo: p?.studentNo ?? null, campusId: p?.campusId ?? null, campusName: p ? (campuses.get(p.campusId) ?? null) : null, academicStatus: p?.academicStatus ?? null, enrollTerm: p?.enrollTerm ?? null, program: p?.program ?? null };
    });
  }

  @Get("export")
  @RequirePermissions(PERMS.hrStudentList)
  async export(@Auth() auth: AuthContext, @Res() res: Response) {
    const rows = await this.index(auth, { page: "1", size: "100" });
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", 'attachment; filename="students.csv"');
    res.send(toCsv(["student_no", "name", "campus", "program", "enroll_term", "status"], rows.map((r) => [r.studentNo, r.fullName, r.campusName, r.program, r.enrollTerm, r.academicStatus])));
  }

  @Get(":id")
  @RequirePermissions(PERMS.hrStudentList)
  async get(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const { row } = await this.scoped(auth, id, PERMS.hrStudentList);
    const scope = await this.hr.scope(auth, PERMS.hrPersonSensitive);
    return this.view(row.id, auth.authz.perms.includes(PERMS.hrPersonSensitive) && (await this.hr.inFullScope(scope, id)));
  }

  /** 新建学员：选校区（该校区必须"正常"，且在操作者数据范围内）；先按邮箱查重，已有自然人则在其上加学员档案。 */
  @Post()
  @RequirePermissions(PERMS.hrStudentAdd)
  async create(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(createSchema, body);
    const tenant = requireTenant("create student");
    const scope = await this.hr.scope(auth, PERMS.hrStudentAdd);
    const campus = await this.db.campus.findUnique({ where: { id: input.campusId } });
    if (!campus) throw new BadRequestException("Unknown campus");
    this.hr.assertDeptInScope(scope, campus.deptId);
    await this.hr.validateNewPlacement(campus.deptId);
    const personId = input.personId;
    if (personId) {
      await this.hr.person(personId);
      if (await this.db.studentProfile.findFirst({ where: { personId } })) throw new ConflictException("This person already has a student profile");
    } else {
      if (!input.fullName) throw new BadRequestException("A name is required");
      const dup = await this.staff.findDuplicate(input.workEmail, null);
      if (dup) throw new ConflictException({ code: "DUPLICATE_PERSON", message: "A person with this e-mail already exists; add the student profile to that person instead", existing: dup });
    }
    const all = await this.db.studentProfile.findMany({ select: { studentNo: true } });
    const max = all.map((s) => /^S(\d+)$/.exec(s.studentNo)?.[1]).filter((n): n is string => !!n).reduce((m, n) => Math.max(m, Number(n)), 0);
    const studentNo = input.studentNo ?? `S${String(max + 1).padStart(4, "0")}`;
    try {
      const id = await this.hr.tenantDb.transaction(async (tx) => {
        const pid = personId ?? (await tx.person.create({ data: { tenantId: tenant.tenantId, type: "student", fullName: input.fullName as string, workEmail: input.workEmail ?? null, createdBy: auth.accountId } })).id;
        await tx.studentProfile.create({ data: { tenantId: tenant.tenantId, personId: pid, studentNo, campusId: campus.id, enrollTerm: input.enrollTerm ?? null, degreeType: input.degreeType ?? null, program: input.program ?? null, createdBy: auth.accountId } });
        await tx.personDept.create({ data: { tenantId: tenant.tenantId, personId: pid, deptId: campus.deptId, kind: "student", isPrimary: true, startDate: todayUtc() } });
        return pid;
      });
      await this.authz.bump(auth.tenantId);
      await this.audit.record(auth.accountId, "student.create", "person", id, { studentNo });
      return { personId: id, studentNo };
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw new ConflictException("Student number or e-mail already exists");
      throw err;
    }
  }

  @Patch(":id")
  @RequirePermissions(PERMS.hrStudentEdit)
  async update(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(patchSchema, body);
    const { scope } = await this.scoped(auth, id, PERMS.hrStudentEdit);
    const tenant = requireTenant("update student");
    const profile = await this.db.studentProfile.findFirst({ where: { personId: id } });
    if (!profile) throw new NotFoundException();
    if (input.campusId && input.campusId !== profile.campusId) {
      const to = await this.db.campus.findUnique({ where: { id: input.campusId } });
      if (!to) throw new BadRequestException("Unknown campus");
      this.hr.assertDeptInScope(scope, to.deptId);
      await this.hr.validateNewPlacement(to.deptId);
      // 转校区：旧归属填结束日期，新增新归属
      await this.hr.tenantDb.transaction(async (tx) => {
        await tx.personDept.updateMany({ where: { personId: id, kind: "student", endDate: null }, data: { endDate: dayBefore(todayUtc()) } });
        await tx.personDept.create({ data: { tenantId: tenant.tenantId, personId: id, deptId: to.deptId, kind: "student", isPrimary: true, startDate: todayUtc() } });
      });
    } else if (input.campusId === undefined && Object.keys(input).length === 0) throw new ForbiddenException("Nothing to change");
    await this.db.studentProfile.update({ where: { id: profile.id }, data: { ...input, updatedBy: auth.accountId } });
    if (input.academicStatus && input.academicStatus !== profile.academicStatus) {
      const terminal = input.academicStatus === "graduated" || input.academicStatus === "withdrawn" || input.academicStatus === "completed";
      if (terminal) {
        // 毕业/退学/结业：组织树上的归属结束（历史保留）
        await this.db.personDept.updateMany({ where: { personId: id, kind: "student", endDate: null }, data: { endDate: dayBefore(todayUtc()) } });
      } else if (!(await this.db.personDept.findFirst({ where: { personId: id, kind: "student", endDate: null } }))) {
        const campus = await this.db.campus.findUnique({ where: { id: input.campusId ?? profile.campusId } });
        if (campus) await this.db.personDept.create({ data: { tenantId: tenant.tenantId, personId: id, deptId: campus.deptId, kind: "student", isPrimary: true, startDate: todayUtc() } });
      }
    }
    await this.authz.bump(auth.tenantId);
    await this.audit.record(auth.accountId, "student.update", "person", id, input);
    return this.view(id);
  }
}
