// 学生门户的教学接口：选课、退课、我的选课、培养方案、班级课件。
// 一切以"我"为准（令牌里的账号 → 人员）；学生看不到别人的任何选课。权限字符来自门户入口下的菜单，学生角色自动拥有。
import { resolveVersion } from "@staredu/shared";
import { Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { todayUtc } from "../hr/effective";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { schedulesOverlap, type ScheduleItem } from "./edu-common";
import { EnrollmentService } from "./enrollment.service";

@Controller("api/portal")
export class PortalController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly enrollments: EnrollmentService,
  ) {}

  private get db() {
    return this.tenantDb.db;
  }

  private async me(auth: AuthContext) {
    const personId = auth.authz.personId;
    const profile = personId ? await this.db.studentProfile.findFirst({ where: { personId } }) : null;
    if (!personId || !profile) throw new ForbiddenException("This area is for students");
    return { personId, profile };
  }

  /** 我的专业（主修）的课程设置：courseId → 类别、建议学期。 */
  private async myMajor(personId: string) {
    const declared = await this.db.studentMajor.findFirst({ where: { personId, kind: "primary", active: true } });
    if (!declared) return null;
    const major = await this.db.major.findUnique({ where: { id: declared.majorId } });
    // 按入学年份落在哪个培养方案版本，就用哪个版本的课程设置和学分要求
    const version = resolveVersion(await this.db.majorVersion.findMany({ where: { majorId: declared.majorId } }), declared.entryYear);
    const items = version ? await this.db.majorCourse.findMany({ where: { versionId: version.id } }) : [];
    return { major, version, items: new Map(items.map((i) => [i.courseId, i])) };
  }

  @Get("sections")
  @RequirePermissions(PERMS.portalEnrollList)
  async openSections(@Auth() auth: AuthContext, @Query() query: { filter?: string }) {
    const { personId } = await this.me(auth);
    const major = await this.myMajor(personId);
    const sections = await this.db.section.findMany({ where: { status: "open", term: { status: { in: ["enrolling", "in_progress"] } } }, include: { course: true, term: true, campus: true, instructors: true }, orderBy: { name: "asc" } });
    const mine = await this.db.enrollment.findMany({ where: { studentPersonId: personId, status: { in: ["enrolled", "completed"] } }, include: { section: true } });
    const passedCourses = new Set(mine.filter((e) => e.passed).map((e) => e.section.courseId));
    const activeCourses = new Set(mine.filter((e) => e.status === "enrolled").map((e) => e.section.courseId));
    const names = new Map((await this.db.person.findMany({ where: { id: { in: sections.flatMap((s) => s.instructors.map((i) => i.personId)) } }, select: { id: true, fullName: true } })).map((p) => [p.id, p.fullName]));
    const prereqs = await this.db.coursePrerequisite.findMany({ include: { prerequisite: true } });
    const rows = [];
    for (const s of sections) {
      const requirement = major?.items.get(s.courseId)?.category ?? null;
      if (query.filter === "mine" && !requirement) continue;
      const seated = await this.db.enrollment.count({ where: { sectionId: s.id, status: "enrolled" } });
      const missing = prereqs.filter((p) => p.courseId === s.courseId && !passedCourses.has(p.prerequisiteId)).map((p) => p.prerequisite.code);
      const clashes = mine
        .filter((e) => e.status === "enrolled" && e.section.termId === s.termId && e.sectionId !== s.id) // 自己已选的这个班不算和自己冲突
        .filter((e) => schedulesOverlap(s.schedule as unknown as ScheduleItem[], e.section.schedule as unknown as ScheduleItem[]))
        .map((e) => e.section.name);
      rows.push({
        id: s.id, name: s.name, course: { id: s.courseId, code: s.course.code, name: s.course.name, credits: Number(s.course.credits) }, term: s.term.name, campus: s.campus.name, mode: s.mode, schedule: s.schedule,
        capacity: s.capacity, seatsLeft: Math.max(0, s.capacity - seated), instructors: s.instructors.map((i) => ({ role: i.role, fullName: names.get(i.personId) ?? null })),
        requirement, // 对我的专业是必修/选修/通识；没申报专业时是 null
        prerequisitesMet: missing.length === 0, missingPrerequisites: missing, conflicts: clashes, alreadyTaking: activeCourses.has(s.courseId), alreadyPassed: passedCourses.has(s.courseId),
      });
    }
    return { declaredMajor: major ? { id: major.major?.id, name: major.major?.name } : null, sections: rows };
  }

  @Post("enrollments")
  @RequirePermissions(PERMS.portalEnrollAdd)
  async enroll(@Auth() auth: AuthContext, @Body() body: unknown) {
    const { sectionId } = parse(z.object({ sectionId: z.string().uuid() }), body);
    const { personId } = await this.me(auth);
    return this.enrollments.enroll({ sectionId, studentPersonId: personId, method: "self", actorAccountId: auth.accountId });
  }

  @Delete("enrollments/:id")
  @RequirePermissions(PERMS.portalEnrollDrop)
  async drop(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const { personId } = await this.me(auth);
    return this.enrollments.drop({ enrollmentId: id, actorAccountId: auth.accountId, actorPersonId: personId, byRegistrar: false });
  }

  /** 我的选课（含已作废的不列出；退课 W 列出）。 */
  @Get("my-enrollments")
  @RequirePermissions(PERMS.portalEnrollList)
  async mine(@Auth() auth: AuthContext) {
    const { personId } = await this.me(auth);
    const rows = await this.db.enrollment.findMany({ where: { studentPersonId: personId, status: { in: ["enrolled", "withdrawn", "completed"] } }, include: { section: { include: { course: true, term: true } } }, orderBy: { enrolledAt: "desc" } });
    const deadline = (t: Date | null) => t?.toISOString().slice(0, 10) ?? null;
    return rows.map((e) => ({ id: e.id, status: e.status, passed: e.passed, section: { id: e.sectionId, name: e.section.name, status: e.section.status }, course: { code: e.section.course.code, name: e.section.course.name, credits: Number(e.section.course.credits) }, term: e.section.term.name, dropDeadline: deadline(e.section.term.dropDeadline), canDrop: e.status === "enrolled" && e.section.term.status !== "ended" && e.section.status !== "ended", willBeW: !!e.section.term.dropDeadline && todayUtc() > e.section.term.dropDeadline }));
  }

  /** 培养方案：我的专业的课程，每门标注 已修 / 进行中 / 未修，学分进度只统计已通过的课程；不做毕业审核。 */
  @Get("plan")
  @RequirePermissions(PERMS.portalPlanView)
  async plan(@Auth() auth: AuthContext) {
    const { personId } = await this.me(auth);
    const major = await this.myMajor(personId);
    if (!major?.major) return { declaredMajor: null, message: "Declare a major first", courses: [], credits: { earned: 0, required: 0 } };
    const taken = await this.db.enrollment.findMany({ where: { studentPersonId: personId, status: { in: ["enrolled", "completed"] } }, include: { section: true } });
    const courses = await this.db.course.findMany({ where: { id: { in: [...major.items.keys()] } }, orderBy: { code: "asc" } });
    let earned = 0;
    const items = courses.map((c) => {
      const mine = taken.filter((e) => e.section.courseId === c.id);
      const state = mine.some((e) => e.passed) ? "passed" : mine.some((e) => e.status === "enrolled") ? "in_progress" : "not_taken";
      if (state === "passed") earned += Number(c.credits);
      const cfg = major.items.get(c.id);
      return { courseId: c.id, code: c.code, name: c.name, credits: Number(c.credits), category: cfg?.category, suggestedTerm: cfg?.suggestedTerm ?? null, state };
    });
    return { declaredMajor: { id: major.major.id, name: major.major.name }, courses: items, credits: { earned, required: Number(major.version?.totalCredits ?? major.major.totalCredits) }, version: major.version ? { id: major.version.id, label: major.version.label, effectiveYear: major.version.effectiveYear } : null };
  }

  /** 班级课件：选课的学生可看已发布的（已作废/退课的失去访问；结课后保留只读）。 */
  @Get("sections/:id/materials")
  @RequirePermissions(PERMS.portalEnrollList)
  async materials(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const { personId } = await this.me(auth);
    const member = await this.db.enrollment.findFirst({ where: { sectionId: id, studentPersonId: personId, status: { in: ["enrolled", "completed"] } } });
    if (!member) throw new NotFoundException();
    return this.db.sectionMaterial.findMany({ where: { sectionId: id, published: true }, orderBy: [{ sort: "asc" }, { createdAt: "asc" }] });
  }
}
