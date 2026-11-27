// 教学目录：学期、课程、专业（含课程设置、学生申报专业）。这些是教务维护的"目录"，不是个人数据，
// 所以只按权限字符控制；班级、选课才按数据范围。
import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query } from "@nestjs/common";
import type { Prisma } from "../generated/prisma";
import { z } from "zod";
import { PERMS, resolveVersion, versionRanges } from "@staredu/shared";
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
import { extendedEvents } from "../events/event-bus";
import { EnrollmentService } from "./enrollment.service";
import { OutboxService } from "./outbox.service";

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
    private readonly outbox: OutboxService,
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
  async courses(@Query() query: { q?: string; limit?: string; status?: string }) {
    const q = query.q?.trim();
    // 选择器用：limit 限制返回条数、status=enabled 只要启用的课（课程多的时候不要一次把全部取出来）
    const limit = query.limit === undefined ? undefined : Math.min(Math.max(Math.trunc(Number(query.limit)) || 1, 1), 100);
    const rows = await this.db.course.findMany({
      where: { ...(query.status === "enabled" ? { status: true } : {}), ...(q ? { OR: [{ code: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }] } : {}) },
      orderBy: { code: "asc" },
      ...(limit ? { take: limit } : {}),
    });
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
      majors: [...new Map(majors.map((m) => [m.majorId, m])).values()].map((m) => ({ id: m.majorId, code: m.major.code, name: m.major.name, category: m.category })), // 只读，在专业的课程设置里维护
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
      if (extendedEvents() && c.syllabus) await this.outbox.emit("course.syllabus_changed", { courseId: c.id });
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
      // 大纲、名称或状态变了：知识库要更新（kafka 模式；事件里只有课程 id）
      if (extendedEvents() && (input.syllabus !== undefined || input.name !== undefined || input.status !== undefined)) await this.outbox.emit("course.syllabus_changed", { courseId: id });
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

  /** 专业的版本，按生效年份升序。 */
  private async versionsOf(majorId: string) {
    return this.db.majorVersion.findMany({ where: { majorId }, orderBy: { effectiveYear: "asc" } });
  }

  /** 取要操作的版本：指定了就用指定的（必须属于这个专业），没指定用最新版本。 */
  private async targetVersion(majorId: string, versionId?: string) {
    const versions = await this.versionsOf(majorId);
    const v = versionId ? versions.find((x) => x.id === versionId) : versions[versions.length - 1];
    if (!v) throw new NotFoundException();
    return v;
  }

  /** 专业上的学分字段始终镜像最新版本（旧的列表和页面继续可用）。 */
  private async syncMajorFromLatest(tx: Prisma.TransactionClient, majorId: string) {
    const latest = await tx.majorVersion.findFirst({ where: { majorId }, orderBy: { effectiveYear: "desc" } });
    if (latest) await tx.major.update({ where: { id: majorId }, data: { totalCredits: latest.totalCredits, electiveMinCredits: latest.electiveMinCredits } });
  }

  private versionView(v: { id: string; label: string; effectiveYear: number; totalCredits: unknown; electiveMinCredits: unknown }, range?: { from: number | null; to: number | null }, courseCount?: number) {
    return { id: v.id, label: v.label, effectiveYear: v.effectiveYear, totalCredits: Number(v.totalCredits), electiveMinCredits: Number(v.electiveMinCredits), entryYearFrom: range?.from ?? null, entryYearTo: range?.to ?? null, courseCount: courseCount ?? null };
  }

  @Get("majors/:id")
  @RequirePermissions(PERMS.eduMajorList)
  async major(@Param("id", ParseUUIDPipe) id: string, @Query() query: { version?: string }) {
    const m = await this.db.major.findUnique({ where: { id } });
    if (!m) throw new NotFoundException();
    const versions = await this.versionsOf(id);
    const chosen = await this.targetVersion(id, query.version);
    const counts = await this.db.majorCourse.groupBy({ by: ["versionId"], where: { majorId: id }, _count: { _all: true } });
    const ranges = new Map(versionRanges(versions).map((r) => [r.id, r]));
    const items = await this.db.majorCourse.findMany({ where: { versionId: chosen.id }, include: { course: true }, orderBy: [{ category: "asc" }, { suggestedTerm: "asc" }] });
    return {
      id: m.id, code: m.code, name: m.name, degreeType: m.degreeType, deptId: m.deptId, totalCredits: Number(chosen.totalCredits), electiveMinCredits: Number(chosen.electiveMinCredits), description: m.description, status: m.status,
      versionId: chosen.id,
      versions: versions.map((v) => this.versionView(v, ranges.get(v.id), counts.find((c) => c.versionId === v.id)?._count._all ?? 0)),
      courses: items.map((i) => ({ courseId: i.courseId, code: i.course.code, name: i.course.name, credits: Number(i.course.credits), category: i.category, suggestedTerm: i.suggestedTerm, note: i.note })),
    };
  }

  @Post("majors")
  @RequirePermissions(PERMS.eduMajorAdd)
  async createMajor(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{2,30}$/), name: z.string().trim().min(1).max(200), degreeType: z.string().max(50).nullable().optional(), deptId: z.string().uuid().nullable().optional(), totalCredits: z.number().min(0).max(999).optional(), electiveMinCredits: z.number().min(0).max(999).optional(), description: z.string().max(5000).nullable().optional() }), body);
    if (input.deptId) await assertVisible(this.db.dept, [input.deptId], "department");
    try {
      const m = await this.tenantDb.transaction(async (tx) => {
        const major = await tx.major.create({ data: { tenantId: auth.tenantId, ...input, createdBy: auth.accountId } });
        await tx.majorVersion.create({ data: { tenantId: auth.tenantId, majorId: major.id, label: "Initial", effectiveYear: 2000, totalCredits: input.totalCredits ?? 0, electiveMinCredits: input.electiveMinCredits ?? 0, createdBy: auth.accountId } });
        return major;
      });
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
    const m = await this.tenantDb.transaction(async (tx) => {
      const row = await tx.major.update({ where: { id }, data: { ...input, updatedBy: auth.accountId } });
      if (input.totalCredits !== undefined || input.electiveMinCredits !== undefined) {
        const latest = await tx.majorVersion.findFirst({ where: { majorId: id }, orderBy: { effectiveYear: "desc" } });
        if (latest) await tx.majorVersion.update({ where: { id: latest.id }, data: { ...(input.totalCredits !== undefined ? { totalCredits: input.totalCredits } : {}), ...(input.electiveMinCredits !== undefined ? { electiveMinCredits: input.electiveMinCredits } : {}) } });
      }
      return row;
    });
    return { id: m.id, status: m.status };
  }

  /** 课程设置：整体替换。类别（必修/选修/通识）是专业和课程这条关系的属性。 */
  @Put("majors/:id/courses")
  @RequirePermissions(PERMS.eduMajorEdit)
  async setMajorCourses(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @Query() query: { version?: string }) {
    const { items } = parse(z.object({ items: z.array(z.object({ courseId: z.string().uuid(), category: z.enum(["required", "elective", "general"]), suggestedTerm: z.number().int().min(1).max(20).nullable().optional(), note: z.string().max(500).nullable().optional() })).max(300) }), body);
    if (!(await this.db.major.findUnique({ where: { id } }))) throw new NotFoundException();
    const version = await this.targetVersion(id, query.version);
    const ids = items.map((i) => i.courseId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException("A course can appear only once in a major");
    await assertVisible(this.db.course, ids, "course");
    await this.tenantDb.transaction(async (tx) => {
      await tx.majorCourse.deleteMany({ where: { versionId: version.id } });
      if (items.length) await tx.majorCourse.createMany({ data: items.map((i) => ({ tenantId: auth.tenantId, majorId: id, versionId: version.id, courseId: i.courseId, category: i.category, suggestedTerm: i.suggestedTerm ?? null, note: i.note ?? null })) });
    });
    await this.audit.record(auth.accountId, "major.courses", "major", id, { count: items.length, versionId: version.id });
    return { id, versionId: version.id, count: items.length };
  }

  /** 新增培养方案版本：从某个入学年份起生效。默认复制最新版本的课程设置和学分要求，之后可以单独改。 */
  @Post("majors/:id/versions")
  @RequirePermissions(PERMS.eduMajorEdit)
  async createVersion(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(z.object({ label: z.string().trim().min(1).max(60).optional(), effectiveYear: z.number().int().min(1900).max(2200), copyFromVersionId: z.string().uuid().optional() }).strict(), body);
    if (!(await this.db.major.findUnique({ where: { id } }))) throw new NotFoundException();
    const source = await this.targetVersion(id, input.copyFromVersionId);
    if ((await this.versionsOf(id)).some((v) => v.effectiveYear === input.effectiveYear)) throw new ConflictException("A version already starts in that year");
    const created = await this.tenantDb.transaction(async (tx) => {
      const v = await tx.majorVersion.create({ data: { tenantId: auth.tenantId, majorId: id, label: input.label ?? String(input.effectiveYear), effectiveYear: input.effectiveYear, totalCredits: source.totalCredits, electiveMinCredits: source.electiveMinCredits, createdBy: auth.accountId } });
      const items = await tx.majorCourse.findMany({ where: { versionId: source.id } });
      if (items.length) await tx.majorCourse.createMany({ data: items.map((i) => ({ tenantId: auth.tenantId, majorId: id, versionId: v.id, courseId: i.courseId, category: i.category, suggestedTerm: i.suggestedTerm, note: i.note })) });
      await this.syncMajorFromLatest(tx, id);
      return { v, copied: items.length };
    });
    await this.audit.record(auth.accountId, "major.version.create", "major", id, { versionId: created.v.id, effectiveYear: input.effectiveYear, copiedFrom: source.id, copied: created.copied });
    return { id: created.v.id, copied: created.copied };
  }

  @Patch("majors/:id/versions/:versionId")
  @RequirePermissions(PERMS.eduMajorEdit)
  async updateVersion(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Param("versionId", ParseUUIDPipe) versionId: string, @Body() body: unknown) {
    const input = parse(z.object({ label: z.string().trim().min(1).max(60).optional(), totalCredits: z.number().min(0).max(999).optional(), electiveMinCredits: z.number().min(0).max(999).optional() }).strict(), body);
    const v = await this.targetVersion(id, versionId);
    await this.tenantDb.transaction(async (tx) => {
      await tx.majorVersion.update({ where: { id: v.id }, data: input });
      await this.syncMajorFromLatest(tx, id);
    });
    await this.audit.record(auth.accountId, "major.version.update", "major", id, { versionId, ...input });
    return { id: v.id };
  }

  /** 删除版本：至少保留一个；用到它的学生自动落到前一个版本（没有前一个就落到后一个）。 */
  @Delete("majors/:id/versions/:versionId")
  @RequirePermissions(PERMS.eduMajorEdit)
  async removeVersion(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Param("versionId", ParseUUIDPipe) versionId: string) {
    const versions = await this.versionsOf(id);
    const v = versions.find((x) => x.id === versionId);
    if (!v) throw new NotFoundException();
    if (versions.length === 1) throw new ConflictException("A major must keep at least one version");
    await this.tenantDb.transaction(async (tx) => {
      await tx.majorCourse.deleteMany({ where: { versionId } });
      await tx.majorVersion.delete({ where: { id: versionId } });
      await this.syncMajorFromLatest(tx, id);
    });
    await this.audit.record(auth.accountId, "major.version.remove", "major", id, { versionId, effectiveYear: v.effectiveYear });
    return { id: versionId };
  }

  /** 在读学生（已申报该专业的），只读。按学员的数据范围过滤。 */
  @Get("majors/:id/students")
  @RequirePermissions(PERMS.eduMajorList)
  async majorStudents(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const scope = await this.hr.scope(auth, PERMS.hrStudentList);
    const rows = await this.db.person.findMany({ where: withScope({ student: { isNot: null }, majors: undefined } as never, scope, STUDENT_SCOPE) });
    const declared = await this.db.studentMajor.findMany({ where: { majorId: id, active: true } });
    const byPerson = new Map(declared.map((d) => [d.personId, d]));
    const versions = await this.versionsOf(id);
    return rows.filter((r) => byPerson.has(r.id)).map((r) => {
      const d = byPerson.get(r.id)!;
      return { id: r.id, fullName: r.fullName, entryYear: d.entryYear, versionLabel: resolveVersion(versions, d.entryYear)?.label ?? null };
    });
  }

  /** 学生申报专业（教务操作）。学生要在操作者的学员数据范围内。 */
  @Put("majors/:id/students/:personId")
  @RequirePermissions(PERMS.eduMajorEdit)
  async declare(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Param("personId", ParseUUIDPipe) personId: string, @Body() body: unknown) {
    const { kind, entryYear } = parse(z.object({ kind: z.enum(["primary", "minor"]).default("primary"), entryYear: z.number().int().min(1900).max(2200).optional() }), body ?? {});
    if (!(await this.db.major.findUnique({ where: { id } }))) throw new NotFoundException();
    const scope = await this.hr.scope(auth, PERMS.hrStudentList);
    const student = await this.db.person.findFirst({ where: withScope({ id: personId, student: { isNot: null } }, scope, STUDENT_SCOPE) });
    if (!student) throw new NotFoundException();
    await this.tenantDb.transaction(async (tx) => {
      if (kind === "primary") await tx.studentMajor.updateMany({ where: { personId, kind: "primary", active: true }, data: { active: false } });
      const existing = await tx.studentMajor.findFirst({ where: { personId, majorId: id } });
      if (existing) await tx.studentMajor.update({ where: { id: existing.id }, data: { kind, active: true, ...(entryYear ? { entryYear } : {}) } });
      else await tx.studentMajor.create({ data: { tenantId: auth.tenantId, personId, majorId: id, kind, entryYear: entryYear ?? new Date().getUTCFullYear() } });
    });
    await this.audit.record(auth.accountId, "student.declareMajor", "person", personId, { majorId: id, kind, entryYear: entryYear ?? null });
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
