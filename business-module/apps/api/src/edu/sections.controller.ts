// 班级：开班（教务）、结构修改（教务；任课教师不能改）、状态、任课教师、名单与教务代选、课件（任课教师）。
// 列表和详情按数据范围：教务按校区，教师看自己任教的班，学生在门户里看自己的。内置租户管理员的范围里没有班级。
import { DictService } from "../sysdata/dict.service";
import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { AuditService } from "../audit/audit.service";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { withScope } from "../data-scope/scope-filter";
import { HrAccess, STUDENT_SCOPE } from "../hr/hr-access.service";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { assertVisible } from "../tenancy/owned";
import { scheduleSchema, SECTION_SCOPE } from "./edu-common";
import { extendedEvents } from "../events/event-bus";
import { EnrollmentService } from "./enrollment.service";
import { OutboxService } from "./outbox.service";

const createSchema = z.object({
  courseId: z.string().uuid(),
  termId: z.string().uuid(),
  campusId: z.string().uuid(),
  number: z.string().regex(/^[A-Za-z0-9]{1,10}$/),
  capacity: z.number().int().min(1).max(10000),
  mode: z.enum(["onsite", "online", "hybrid"]).optional(),
  schedule: scheduleSchema.optional(),
  notes: z.string().max(2000).nullable().optional(),
});
const patchSchema = z.object({ capacity: z.number().int().min(1).max(10000).optional(), mode: z.enum(["onsite", "online", "hybrid"]).optional(), schedule: scheduleSchema.optional(), notes: z.string().max(2000).nullable().optional(), campusId: z.string().uuid().optional() }).strict();
const NEXT: Record<string, string[]> = { draft: ["open", "cancelled"], open: ["draft", "in_progress", "cancelled"], in_progress: ["ended", "cancelled"], ended: [], cancelled: [] };
const materialSchema = z.object({ title: z.string().trim().min(1).max(200), category: z.string().trim().min(1).max(50).optional(), url: z.string().url().max(1000), sort: z.number().int().min(0).max(10000).optional(), published: z.boolean().optional() });

@Controller("api/sections")
export class SectionsController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly hr: HrAccess,
    private readonly audit: AuditService,
    private readonly enrollments: EnrollmentService,
    private readonly outbox: OutboxService,
    private readonly dicts: DictService,
  ) {}

  private get db() {
    return this.tenantDb.db;
  }

  /** 在操作者数据范围内的班级，否则 404。 */
  private async scoped(auth: AuthContext, id: string, perm: string) {
    const scope = await this.hr.scope(auth, perm);
    const row = await this.db.section.findFirst({ where: withScope({ id }, scope, SECTION_SCOPE) });
    if (!row) throw new NotFoundException();
    return { scope, row };
  }

  private async view(id: string) {
    const s = await this.db.section.findUnique({ where: { id }, include: { course: true, term: true, campus: true, instructors: true } });
    if (!s) throw new NotFoundException();
    const people = new Map((await this.db.person.findMany({ where: { id: { in: s.instructors.map((i) => i.personId) } }, select: { id: true, fullName: true } })).map((p) => [p.id, p.fullName]));
    const seated = await this.db.enrollment.count({ where: { sectionId: id, status: "enrolled" } });
    return {
      id: s.id, name: s.name, number: s.number, status: s.status, capacity: s.capacity, seated, mode: s.mode, schedule: s.schedule, notes: s.notes,
      course: { id: s.courseId, code: s.course.code, name: s.course.name, credits: Number(s.course.credits) },
      term: { id: s.termId, code: s.term.code, name: s.term.name, status: s.term.status },
      campus: { id: s.campusId, code: s.campus.code, name: s.campus.name, timezone: s.campus.timezone },
      instructors: s.instructors.map((i) => ({ personId: i.personId, role: i.role, fullName: people.get(i.personId) ?? null })),
    };
  }

  @Get()
  @RequirePermissions(PERMS.eduSectionList)
  async list(@Auth() auth: AuthContext, @Query() query: { termId?: string; courseId?: string; campusId?: string; status?: string; q?: string }) {
    const scope = await this.hr.scope(auth, PERMS.eduSectionList);
    const base = { ...(query.termId ? { termId: query.termId } : {}), ...(query.courseId ? { courseId: query.courseId } : {}), ...(query.campusId ? { campusId: query.campusId } : {}), ...(query.status ? { status: query.status as never } : {}), ...(query.q ? { name: { contains: query.q, mode: "insensitive" as const } } : {}) };
    const rows = await this.db.section.findMany({ where: withScope(base, scope, SECTION_SCOPE), orderBy: [{ name: "asc" }] });
    return Promise.all(rows.map((r) => this.view(r.id)));
  }

  @Get(":id")
  @RequirePermissions(PERMS.eduSectionList)
  async get(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    await this.scoped(auth, id, PERMS.eduSectionList);
    return this.view(id);
  }

  @Post()
  @RequirePermissions(PERMS.eduSectionAdd)
  async create(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(createSchema, body);
    await assertVisible(this.db.course, [input.courseId], "course");
    await assertVisible(this.db.term, [input.termId], "term");
    await assertVisible(this.db.campus, [input.campusId], "campus");
    const [course, term, campus] = await Promise.all([this.db.course.findUnique({ where: { id: input.courseId } }), this.db.term.findUnique({ where: { id: input.termId } }), this.db.campus.findUnique({ where: { id: input.campusId } })]);
    const scope = await this.hr.scope(auth, PERMS.eduSectionAdd);
    this.hr.assertDeptInScope(scope, (campus as { deptId: string }).deptId);
    if (!course?.status) throw new ConflictException("The course is disabled; no new sections can be opened");
    if (term?.status === "ended") throw new ConflictException("The term has ended");
    if (campus?.status !== "normal") throw new ConflictException("The campus does not accept new sections");
    try {
      const s = await this.db.section.create({
        data: { tenantId: auth.tenantId, courseId: input.courseId, termId: input.termId, campusId: input.campusId, number: input.number, name: `${course.code}-${input.number} · ${term?.name}`, capacity: input.capacity, mode: input.mode ?? "onsite", schedule: (input.schedule ?? []) as never, notes: input.notes ?? null, createdBy: auth.accountId },
      });
      await this.audit.record(auth.accountId, "section.create", "section", s.id, { name: s.name });
      return this.view(s.id);
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw new ConflictException("This course already has a section with that number in the term");
      throw err;
    }
  }

  /** 改结构信息（容量、安排、校区、说明）：教务才有这个权限，任课教师没有。 */
  @Patch(":id")
  @RequirePermissions(PERMS.eduSectionEdit)
  async update(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(patchSchema, body);
    const { scope, row } = await this.scoped(auth, id, PERMS.eduSectionEdit);
    if (row.status === "ended" || row.status === "cancelled") throw new ConflictException(`The section is ${row.status}`);
    const seated = await this.db.enrollment.count({ where: { sectionId: id, status: "enrolled" } });
    if (input.capacity !== undefined && input.capacity < seated) throw new ConflictException(`${seated} students are already enrolled`);
    if (input.campusId && input.campusId !== row.campusId) {
      if (seated > 0) throw new ConflictException("The campus cannot change while students are enrolled");
      await assertVisible(this.db.campus, [input.campusId], "campus");
      const campus = await this.db.campus.findUnique({ where: { id: input.campusId } });
      this.hr.assertDeptInScope(scope, (campus as { deptId: string }).deptId);
    }
    const { schedule, ...rest } = input;
    await this.db.section.update({ where: { id }, data: { ...rest, ...(schedule ? { schedule: schedule as never } : {}), updatedBy: auth.accountId } });
    await this.audit.record(auth.accountId, "section.update", "section", id, input);
    return this.view(id);
  }

  @Post(":id/status")
  @RequirePermissions(PERMS.eduSectionStatus)
  async status(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { status } = parse(z.object({ status: z.enum(["draft", "open", "in_progress", "ended", "cancelled"]) }), body);
    const { row } = await this.scoped(auth, id, PERMS.eduSectionStatus);
    if (!NEXT[row.status].includes(status)) throw new ConflictException(`Cannot go from ${row.status} to ${status}`);
    let voided = 0;
    if (status === "cancelled") voided = await this.enrollments.cancelSection(id, auth.accountId);
    else {
      if (status === "open" && (await this.db.sectionInstructor.count({ where: { sectionId: id } })) === 0) throw new ConflictException("Assign at least one instructor before opening the section");
      if (status === "draft" && (await this.db.enrollment.count({ where: { sectionId: id, status: "enrolled" } })) > 0) throw new ConflictException("The section has enrolled students");
      await this.tenantDb.transaction(async (tx) => {
        await tx.section.update({ where: { id }, data: { status, updatedBy: auth.accountId } });
        if (status === "ended") await this.enrollments.completeSection(tx, id);
      });
    }
    await this.audit.record(auth.accountId, "section.status", "section", id, { from: row.status, to: status, voided });
    return { ...(await this.view(id)), voidedEnrollments: voided };
  }

  /** 任课教师：整体替换。教师必须是在职教职员工；同一个人在同一个班不能既是老师又是学生（数据库触发器兜底）。 */
  @Put(":id/instructors")
  @RequirePermissions(PERMS.eduSectionEdit)
  async instructors(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { items } = parse(z.object({ items: z.array(z.object({ personId: z.string().uuid(), role: z.enum(["lead", "assistant"]) })).max(20) }), body);
    const { row } = await this.scoped(auth, id, PERMS.eduSectionEdit);
    if (row.status === "ended" || row.status === "cancelled") throw new ConflictException(`The section is ${row.status}`);
    const ids = items.map((i) => i.personId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException("A person can be listed once");
    await assertVisible(this.db.person, ids, "person");
    for (const pid of ids) {
      const staff = await this.db.staffProfile.findFirst({ where: { personId: pid } });
      if (!staff || staff.status !== "active") throw new ConflictException("Instructors must be active staff members");
    }
    try {
      await this.tenantDb.transaction(async (tx) => {
        await tx.sectionInstructor.deleteMany({ where: { sectionId: id } });
        if (items.length) await tx.sectionInstructor.createMany({ data: items.map((i) => ({ tenantId: auth.tenantId, sectionId: id, personId: i.personId, role: i.role })) });
      });
    } catch (err) {
      if (String((err as Error).message).includes("both instructor and student")) throw new ConflictException("A person cannot be both instructor and student in the same section");
      throw err;
    }
    await this.audit.record(auth.accountId, "section.instructors", "section", id, { count: items.length });
    return this.view(id);
  }

  // ------------------------------------------------------------ 名单与教务代选
  @Get(":id/roster")
  @RequirePermissions(PERMS.eduEnrollmentList)
  async roster(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    await this.scoped(auth, id, PERMS.eduEnrollmentList);
    const rows = await this.db.enrollment.findMany({ where: { sectionId: id }, orderBy: { enrolledAt: "asc" } });
    const people = new Map((await this.db.person.findMany({ where: { id: { in: rows.map((r) => r.studentPersonId) } }, select: { id: true, fullName: true } })).map((p) => [p.id, p.fullName]));
    const profiles = new Map((await this.db.studentProfile.findMany({ where: { personId: { in: rows.map((r) => r.studentPersonId) } } })).map((p) => [p.personId, p.studentNo]));
    return rows.map((r) => ({ id: r.id, studentPersonId: r.studentPersonId, fullName: people.get(r.studentPersonId) ?? null, studentNo: profiles.get(r.studentPersonId) ?? null, status: r.status, method: r.method, reason: r.reason, overrides: r.overrides, enrolledAt: r.enrolledAt, droppedAt: r.droppedAt }));
  }

  /** 教务代选：和学生自助调用同一个选课服务；超员、先修未满足、时间冲突、窗口外要确认并填原因。 */
  @Post(":id/enrollments")
  @RequirePermissions(PERMS.eduEnrollmentAdd)
  async enrollStudents(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(z.object({ studentIds: z.array(z.string().uuid()).min(1).max(100), confirm: z.array(z.enum(["capacity", "prerequisite", "conflict", "window", "retake"])).optional(), reason: z.string().trim().max(500).optional() }), body);
    await this.scoped(auth, id, PERMS.eduEnrollmentAdd);
    const studentScope = await this.hr.scope(auth, PERMS.eduEnrollmentAdd);
    const results: Array<{ studentId: string; ok: boolean; enrollmentId?: string; code?: string; violations?: string[]; message?: string }> = [];
    for (const studentId of input.studentIds) {
      if (!(await this.db.person.findFirst({ where: withScope({ id: studentId, student: { isNot: null } }, studentScope, STUDENT_SCOPE) }))) {
        results.push({ studentId, ok: false, code: "NOT_FOUND", message: "Unknown student or outside your data scope" });
        continue;
      }
      try {
        const r = await this.enrollments.enroll({ sectionId: id, studentPersonId: studentId, method: "registrar", actorAccountId: auth.accountId, confirm: input.confirm, reason: input.reason });
        results.push({ studentId, ok: true, enrollmentId: r.enrollmentId });
      } catch (err) {
        const res = (err as { getResponse?: () => unknown }).getResponse?.() as { code?: string; message?: string; violations?: string[] } | undefined;
        if (!res || typeof res !== "object") throw err;
        results.push({ studentId, ok: false, code: res.code, message: res.message, violations: res.violations });
      }
    }
    return { results };
  }

  @Delete(":id/enrollments/:enrollmentId")
  @RequirePermissions(PERMS.eduEnrollmentRemove)
  async removeEnrollment(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Param("enrollmentId", ParseUUIDPipe) enrollmentId: string) {
    await this.scoped(auth, id, PERMS.eduEnrollmentRemove);
    const e = await this.db.enrollment.findFirst({ where: { id: enrollmentId, sectionId: id } });
    if (!e) throw new NotFoundException();
    return this.enrollments.drop({ enrollmentId, actorAccountId: auth.accountId, byRegistrar: true });
  }

  // ------------------------------------------------------------ 课件
  private async isInstructor(auth: AuthContext, sectionId: string): Promise<boolean> {
    return !!auth.authz.personId && !!(await this.db.sectionInstructor.findFirst({ where: { sectionId, personId: auth.authz.personId } }));
  }

  /** 教师（含助教）看全部；教务按范围也看全部；其他人只看已发布的。 */
  @Get(":id/materials")
  @RequirePermissions(PERMS.eduSectionList)
  async materials(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    await this.scoped(auth, id, PERMS.eduSectionList);
    const all = await this.db.sectionMaterial.findMany({ where: { sectionId: id }, orderBy: [{ sort: "asc" }, { createdAt: "asc" }] });
    return (await this.isInstructor(auth, id)) || auth.authz.perms.includes(PERMS.eduEnrollmentAdd) ? all : all.filter((m) => m.published);
  }

  /** 课件清单变了：知识库要更新（kafka 模式；事件里只有班级和课程 id）。 */
  private async materialChanged(sectionId: string, courseId: string): Promise<void> {
    if (extendedEvents()) await this.outbox.emit("material.changed", { sectionId, courseId });
  }

  private async editableSection(auth: AuthContext, id: string) {
    const { row } = await this.scoped(auth, id, PERMS.eduSectionList);
    if (!(await this.isInstructor(auth, id))) throw new ForbiddenException("Only the section's instructors may change its materials");
    if (row.status === "ended" || row.status === "cancelled") throw new ConflictException("The section has ended; its materials are read-only");
    return row;
  }

  @Post(":id/materials")
  @RequirePermissions(PERMS.eduMaterialEdit)
  async addMaterial(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(materialSchema, body);
    if (input.category) await this.dicts.assertValue("material_category", input.category, "category");
    const section = await this.editableSection(auth, id);
    const created = await this.db.sectionMaterial.create({ data: { tenantId: auth.tenantId, sectionId: id, ...input, createdBy: auth.accountId } });
    await this.materialChanged(id, section.courseId);
    return created;
  }

  @Patch(":id/materials/:materialId")
  @RequirePermissions(PERMS.eduMaterialEdit)
  async updateMaterial(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Param("materialId", ParseUUIDPipe) materialId: string, @Body() body: unknown) {
    const input = parse(materialSchema.partial().strict(), body);
    if (input.category) await this.dicts.assertValue("material_category", input.category, "category");
    const section = await this.editableSection(auth, id);
    if (!(await this.db.sectionMaterial.findFirst({ where: { id: materialId, sectionId: id } }))) throw new NotFoundException();
    const updated = await this.db.sectionMaterial.update({ where: { id: materialId }, data: input });
    await this.materialChanged(id, section.courseId);
    return updated;
  }

  @Delete(":id/materials/:materialId")
  @RequirePermissions(PERMS.eduMaterialEdit)
  async removeMaterial(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Param("materialId", ParseUUIDPipe) materialId: string) {
    const section = await this.editableSection(auth, id);
    const { count } = await this.db.sectionMaterial.deleteMany({ where: { id: materialId, sectionId: id } });
    if (!count) throw new NotFoundException();
    await this.materialChanged(id, section.courseId);
    return { id: materialId };
  }
}
