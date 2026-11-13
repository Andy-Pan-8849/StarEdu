// 教学目录：学期、课程、专业（含课程设置、学生申报专业）。这些是教务维护的"目录"，不是个人数据，
// 所以只按权限字符控制；班级、选课才按数据范围。
import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { AuditService } from "../audit/audit.service";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { parseDay } from "../hr/effective";
import { HrAccess, STUDENT_SCOPE } from "../hr/hr-access.service";
import { withScope } from "../data-scope/scope-filter";
import { assertVisible } from "../tenancy/owned";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { dayString } from "./edu-common";
import { EnrollmentService } from "./enrollment.service";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => parseDay(v) !== null).transform((v) => parseDay(v) as Date);
const termBase = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{2,30}$/),
  name: z.string().trim().min(1).max(100),
  startDate: day,
  endDate: day,
  enrollOpenDate: day.nullable().optional(),
  enrollCloseDate: day.nullable().optional(),
  dropDeadline: day.nullable().optional(),
});
const checkTerm = (t: { startDate?: Date; endDate?: Date; enrollOpenDate?: Date | null; enrollCloseDate?: Date | null; dropDeadline?: Date | null }) => {
  if (t.startDate && t.endDate && t.startDate >= t.endDate) throw new BadRequestException("The term must end after it starts");
  if (t.enrollOpenDate && t.enrollCloseDate && t.enrollOpenDate > t.enrollCloseDate) throw new BadRequestException("The enrollment window is the wrong way round");
  if (t.dropDeadline && t.startDate && t.endDate && (t.dropDeadline < t.startDate || t.dropDeadline > t.endDate)) throw new BadRequestException("The drop deadline must fall inside the term");
};
const TERM_NEXT: Record<string, string[]> = { planned: ["enrolling"], enrolling: ["planned", "in_progress"], in_progress: ["ended"], ended: [] };

@Controller("api")
export class CatalogController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly hr: HrAccess,
    private readonly enrollments: EnrollmentService,
  ) {}

  private get db() {
    return this.tenantDb.db;
  }

  // ------------------------------------------------------------ 学期
  private termView(t: { id: string; code: string; name: string; startDate: Date; endDate: Date; enrollOpenDate: Date | null; enrollCloseDate: Date | null; dropDeadline: Date | null; status: string }) {
    return { id: t.id, code: t.code, name: t.name, startDate: dayString(t.startDate), endDate: dayString(t.endDate), enrollOpenDate: dayString(t.enrollOpenDate), enrollCloseDate: dayString(t.enrollCloseDate), dropDeadline: dayString(t.dropDeadline), status: t.status };
  }

  @Get("terms")
  @RequirePermissions(PERMS.eduTermList)
  async terms() {
    return (await this.db.term.findMany({ orderBy: { startDate: "desc" } })).map((t) => this.termView(t));
  }

  @Get("terms/:id")
  @RequirePermissions(PERMS.eduTermList)
  async term(@Param("id", ParseUUIDPipe) id: string) {
    const t = await this.db.term.findUnique({ where: { id } });
    if (!t) throw new NotFoundException();
    return this.termView(t);
  }

  @Post("terms")
  @RequirePermissions(PERMS.eduTermAdd)
  async createTerm(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(termBase, body);
    checkTerm(input);
    try {
      const t = await this.db.term.create({ data: { tenantId: auth.tenantId, ...input, createdBy: auth.accountId } });
      await this.audit.record(auth.accountId, "term.create", "term", t.id, { code: t.code });
      return this.termView(t);
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw new ConflictException("Term code already exists");
      throw err;
    }
  }

  @Patch("terms/:id")
  @RequirePermissions(PERMS.eduTermEdit)
  async updateTerm(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(termBase.omit({ code: true }).partial().strict(), body);
    const current = await this.db.term.findUnique({ where: { id } });
    if (!current) throw new NotFoundException();
    if (current.status === "ended") throw new ConflictException("An ended term cannot be changed");
    checkTerm({ startDate: current.startDate, endDate: current.endDate, enrollOpenDate: current.enrollOpenDate, enrollCloseDate: current.enrollCloseDate, dropDeadline: current.dropDeadline, ...input });
    return this.termView(await this.db.term.update({ where: { id }, data: { ...input, updatedBy: auth.accountId } }));
  }

  /** 学期状态：计划中 → 选课中 → 进行中 → 已结束。结束时：开放/进行中的班级结课，已选的记录转为"已完成"。 */
  @Post("terms/:id/status")
  @RequirePermissions(PERMS.eduTermEdit)
  async termStatus(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { status } = parse(z.object({ status: z.enum(["planned", "enrolling", "in_progress", "ended"]) }), body);
    const t = await this.db.term.findUnique({ where: { id } });
    if (!t) throw new NotFoundException();
    if (!TERM_NEXT[t.status].includes(status)) throw new ConflictException(`Cannot go from ${t.status} to ${status}`);
    await this.tenantDb.transaction(async (tx) => {
      await tx.term.update({ where: { id }, data: { status, updatedBy: auth.accountId } });
      if (status === "ended") {
        const open = await tx.section.findMany({ where: { termId: id, status: { in: ["open", "in_progress"] } }, select: { id: true } });
        for (const s of open) {
          await this.enrollments.completeSection(tx, s.id);
          await tx.section.update({ where: { id: s.id }, data: { status: "ended" } });
        }
      }
    });
    await this.audit.record(auth.accountId, "term.status", "term", id, { from: t.status, to: status });
    return this.termView((await this.db.term.findUnique({ where: { id } }))!);
  }

  // ------------------------------------------------------------ 课程
  private courseCode = z.string().regex(/^[A-Za-z0-9_-]{2,30}$/);

  @Get("courses")
  @RequirePermissions(PERMS.eduCourseList)
  async courses(@Query() query: { q?: string }) {
    const q = query.q?.trim();
    const rows = await this.db.course.findMany({ where: q ? { OR: [{ code: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }] } : {}, orderBy: { code: "asc" } });
    return rows.map((c) => ({ id: c.id, code: c.code, name: c.name, credits: Number(c.credits), status: c.status }));
  }

  @Get("courses/:id")
  @RequirePermissions(PERMS.eduCourseList)
  async course(@Param("id", ParseUUIDPipe) id: string) {
    const c = await this.db.course.findUnique({ where: { id } });
    if (!c) throw new NotFoundException();
    const prereq = await this.db.coursePrerequisite.findMany({ where: { courseId: id }, include: { prerequisite: true } });
    const majors = await this.db.majorCourse.findMany({ where: { courseId: id }, include: { major: true } });
    const sections = await this.db.section.findMany({ where: { courseId: id }, select: { id: true, name: true, status: true } });
    return {
      id: c.id, code: c.code, name: c.name, credits: Number(c.credits), syllabus: c.syllabus, status: c.status, deptId: c.deptId,
      prerequisites: prereq.map((p) => ({ id: p.prerequisiteId, code: p.prerequisite.code, name: p.prerequisite.name })),
      majors: majors.map((m) => ({ id: m.majorId, code: m.major.code, name: m.major.name, category: m.category })), // 只读，在专业的课程设置里维护
      sections, // 历史开班，只读；有了历史班级后编号和学分只读
    };
  }

  @Post("courses")
  @RequirePermissions(PERMS.eduCourseAdd)
  async createCourse(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(z.object({ code: this.courseCode, name: z.string().trim().min(1).max(200), credits: z.number().min(0).max(99), deptId: z.string().uuid().nullable().optional(), syllabus: z.string().max(20000).nullable().optional() }), body);
    if (input.deptId) await assertVisible(this.db.dept, [input.deptId], "department");
    try {
      const c = await this.db.course.create({ data: { tenantId: auth.tenantId, ...input, createdBy: auth.accountId } });
      await this.audit.record(auth.accountId, "course.create", "course", c.id, { code: c.code });
      return { id: c.id, code: c.code };
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw new ConflictException("Course code already exists");
      throw err;
    }
  }

  @Patch("courses/:id")
  @RequirePermissions(PERMS.eduCourseEdit)
  async updateCourse(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(z.object({ code: this.courseCode.optional(), name: z.string().trim().min(1).max(200).optional(), credits: z.number().min(0).max(99).optional(), deptId: z.string().uuid().nullable().optional(), syllabus: z.string().max(20000).nullable().optional(), status: z.boolean().optional() }).strict(), body);
    const c = await this.db.course.findUnique({ where: { id } });
    if (!c) throw new NotFoundException();
    // 有了历史班级以后，编号和学分只读（成绩单要保持当时的学分）
    if ((input.code !== undefined && input.code !== c.code) || (input.credits !== undefined && input.credits !== Number(c.credits))) {
      if ((await this.db.section.count({ where: { courseId: id } })) > 0) throw new ConflictException("The course code and credits are read-only once the course has sections");
    }
    if (input.deptId) await assertVisible(this.db.dept, [input.deptId], "department");
    try {
      const row = await this.db.course.update({ where: { id }, data: { ...input, updatedBy: auth.accountId } });
      return { id: row.id, code: row.code, status: row.status };
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw new ConflictException("Course code already exists");
      throw err;
    }
  }

  /** 先修课（第一版只支持"全部满足"）。不能是自己，不能成环。 */
  @Put("courses/:id/prerequisites")
  @RequirePermissions(PERMS.eduCourseEdit)
  async setPrerequisites(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { courseIds } = parse(z.object({ courseIds: z.array(z.string().uuid()).max(50) }), body);
    if (!(await this.db.course.findUnique({ where: { id } }))) throw new NotFoundException();
    const wanted = [...new Set(courseIds)];
    await assertVisible(this.db.course, wanted, "course");
    if (wanted.includes(id)) throw new BadRequestException("A course cannot be its own prerequisite");
    // 成环检查：从每个先修课出发往上找，不能回到本课程
    const all = await this.db.coursePrerequisite.findMany({});
    const edges = new Map<string, string[]>();
    for (const e of all) if (e.courseId !== id) edges.set(e.courseId, [...(edges.get(e.courseId) ?? []), e.prerequisiteId]);
    const reaches = (from: string, seen = new Set<string>()): boolean => {
      if (from === id) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return (edges.get(from) ?? []).some((n) => reaches(n, seen));
    };
    if (wanted.some((w) => reaches(w))) throw new BadRequestException("These prerequisites would form a cycle");
    await this.tenantDb.transaction(async (tx) => {
      await tx.coursePrerequisite.deleteMany({ where: { courseId: id } });
      if (wanted.length) await tx.coursePrerequisite.createMany({ data: wanted.map((prerequisiteId) => ({ tenantId: auth.tenantId, courseId: id, prerequisiteId })) });
    });
    await this.audit.record(auth.accountId, "course.prerequisites", "course", id, { count: wanted.length });
    return { id, courseIds: wanted };
  }

  // ------------------------------------------------------------ 专业
  @Get("majors")
  @RequirePermissions(PERMS.eduMajorList)
  async majors() {
    const rows = await this.db.major.findMany({ orderBy: { code: "asc" } });
    return rows.map((m) => ({ id: m.id, code: m.code, name: m.name, degreeType: m.degreeType, totalCredits: Number(m.totalCredits), electiveMinCredits: Number(m.electiveMinCredits), status: m.status }));
  }

  @Get("majors/:id")
  @RequirePermissions(PERMS.eduMajorList)
  async major(@Param("id", ParseUUIDPipe) id: string) {
    const m = await this.db.major.findUnique({ where: { id } });
    if (!m) throw new NotFoundException();
    const items = await this.db.majorCourse.findMany({ where: { majorId: id }, include: { course: true }, orderBy: [{ category: "asc" }, { suggestedTerm: "asc" }] });
    return { id: m.id, code: m.code, name: m.name, degreeType: m.degreeType, deptId: m.deptId, totalCredits: Number(m.totalCredits), electiveMinCredits: Number(m.electiveMinCredits), description: m.description, status: m.status, courses: items.map((i) => ({ courseId: i.courseId, code: i.course.code, name: i.course.name, credits: Number(i.course.credits), category: i.category, suggestedTerm: i.suggestedTerm, note: i.note })) };
  }

  @Post("majors")
  @RequirePermissions(PERMS.eduMajorAdd)
  async createMajor(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{2,30}$/), name: z.string().trim().min(1).max(200), degreeType: z.string().max(50).nullable().optional(), deptId: z.string().uuid().nullable().optional(), totalCredits: z.number().min(0).max(999).optional(), electiveMinCredits: z.number().min(0).max(999).optional(), description: z.string().max(5000).nullable().optional() }), body);
    if (input.deptId) await assertVisible(this.db.dept, [input.deptId], "department");
    try {
      const m = await this.db.major.create({ data: { tenantId: auth.tenantId, ...input, createdBy: auth.accountId } });
      return { id: m.id, code: m.code };
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw new ConflictException("Major code already exists");
      throw err;
    }
  }

  @Patch("majors/:id")
  @RequirePermissions(PERMS.eduMajorEdit)
  async updateMajor(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(z.object({ name: z.string().trim().min(1).max(200).optional(), degreeType: z.string().max(50).nullable().optional(), deptId: z.string().uuid().nullable().optional(), totalCredits: z.number().min(0).max(999).optional(), electiveMinCredits: z.number().min(0).max(999).optional(), description: z.string().max(5000).nullable().optional(), status: z.boolean().optional() }).strict(), body);
    if (!(await this.db.major.findUnique({ where: { id } }))) throw new NotFoundException();
    if (input.deptId) await assertVisible(this.db.dept, [input.deptId], "department");
    const m = await this.db.major.update({ where: { id }, data: { ...input, updatedBy: auth.accountId } });
    return { id: m.id, status: m.status };
  }

  /** 课程设置：整体替换。类别（必修/选修/通识）是专业和课程这条关系的属性。 */
  @Put("majors/:id/courses")
  @RequirePermissions(PERMS.eduMajorEdit)
  async setMajorCourses(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { items } = parse(z.object({ items: z.array(z.object({ courseId: z.string().uuid(), category: z.enum(["required", "elective", "general"]), suggestedTerm: z.number().int().min(1).max(20).nullable().optional(), note: z.string().max(500).nullable().optional() })).max(300) }), body);
    if (!(await this.db.major.findUnique({ where: { id } }))) throw new NotFoundException();
    const ids = items.map((i) => i.courseId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException("A course can appear only once in a major");
    await assertVisible(this.db.course, ids, "course");
    await this.tenantDb.transaction(async (tx) => {
      await tx.majorCourse.deleteMany({ where: { majorId: id } });
      if (items.length) await tx.majorCourse.createMany({ data: items.map((i) => ({ tenantId: auth.tenantId, majorId: id, courseId: i.courseId, category: i.category, suggestedTerm: i.suggestedTerm ?? null, note: i.note ?? null })) });
    });
    await this.audit.record(auth.accountId, "major.courses", "major", id, { count: items.length });
    return { id, count: items.length };
  }

  /** 在读学生（已申报该专业的），只读。按学员的数据范围过滤。 */
  @Get("majors/:id/students")
  @RequirePermissions(PERMS.eduMajorList)
  async majorStudents(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const scope = await this.hr.scope(auth, PERMS.hrStudentList);
    const rows = await this.db.person.findMany({ where: withScope({ student: { isNot: null }, majors: undefined } as never, scope, STUDENT_SCOPE) });
    const declared = await this.db.studentMajor.findMany({ where: { majorId: id, active: true } });
    const ids = new Set(declared.map((d) => d.personId));
    return rows.filter((r) => ids.has(r.id)).map((r) => ({ id: r.id, fullName: r.fullName }));
  }

  /** 学生申报专业（教务操作）。学生要在操作者的学员数据范围内。 */
  @Put("majors/:id/students/:personId")
  @RequirePermissions(PERMS.eduMajorEdit)
  async declare(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Param("personId", ParseUUIDPipe) personId: string, @Body() body: unknown) {
    const { kind } = parse(z.object({ kind: z.enum(["primary", "minor"]).default("primary") }), body ?? {});
    if (!(await this.db.major.findUnique({ where: { id } }))) throw new NotFoundException();
    const scope = await this.hr.scope(auth, PERMS.hrStudentList);
    const student = await this.db.person.findFirst({ where: withScope({ id: personId, student: { isNot: null } }, scope, STUDENT_SCOPE) });
    if (!student) throw new NotFoundException();
    await this.tenantDb.transaction(async (tx) => {
      if (kind === "primary") await tx.studentMajor.updateMany({ where: { personId, kind: "primary", active: true }, data: { active: false } });
      const existing = await tx.studentMajor.findFirst({ where: { personId, majorId: id } });
      if (existing) await tx.studentMajor.update({ where: { id: existing.id }, data: { kind, active: true } });
      else await tx.studentMajor.create({ data: { tenantId: auth.tenantId, personId, majorId: id, kind } });
    });
    await this.audit.record(auth.accountId, "student.declareMajor", "person", personId, { majorId: id, kind });
    return { personId, majorId: id, kind };
  }

  @Delete("majors/:id/students/:personId")
  @RequirePermissions(PERMS.eduMajorEdit)
  async undeclare(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Param("personId", ParseUUIDPipe) personId: string) {
    const scope = await this.hr.scope(auth, PERMS.hrStudentList);
    if (!(await this.db.person.findFirst({ where: withScope({ id: personId, student: { isNot: null } }, scope, STUDENT_SCOPE) }))) throw new NotFoundException();
    const { count } = await this.db.studentMajor.updateMany({ where: { personId, majorId: id }, data: { active: false } });
    if (!count) throw new ForbiddenException("The student has not declared this major");
    return { personId, majorId: id };
  }
}
