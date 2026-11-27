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
import { ObjectStoreService } from "../storage/object-store.service";

@Controller("api/portal")
export class PortalController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly enrollments: EnrollmentService,
    private readonly store: ObjectStoreService,
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

  /** 我的所有有效专业（主修在前，辅修在后），每个带它的培养方案版本（按入学年份）和课程设置：courseId → 类别。 */
  private async myMajors(personId: string) {
    const rows = await this.db.studentMajor.findMany({ where: { personId, active: true }, orderBy: { declaredOn: "asc" } });
    rows.sort((a, b) => Number(b.kind === "primary") - Number(a.kind === "primary"));
    const out = [];
    for (const row of rows) {
      const major = await this.db.major.findUnique({ where: { id: row.majorId } });
      if (!major) continue;
      // 按入学年份落在哪个培养方案版本，就用哪个版本的课程设置和学分要求
      const version = resolveVersion(await this.db.majorVersion.findMany({ where: { majorId: row.majorId } }), row.entryYear);
      const items = version ? await this.db.majorCourse.findMany({ where: { versionId: version.id } }) : [];
      out.push({ row, major, version, items: new Map(items.map((i) => [i.courseId, i])) });
    }
    return out;
  }

  /** 选一个专业：指定了就必须是我自己的（否则 404）；没指定取主修，没有主修取第一个。没有专业返回 null。 */
  private pick<T extends { major: { id: string } }>(majors: T[], majorId?: string): T | null {
    if (majorId) {
      const hit = majors.find((m) => m.major.id === majorId);
      if (!hit) throw new NotFoundException();
      return hit;
    }
    return majors[0] ?? null;
  }

  @Get("sections")
  @RequirePermissions(PERMS.portalEnrollList)
  async openSections(@Auth() auth: AuthContext, @Query() query: { filter?: string; majorId?: string }) {
    const { personId } = await this.me(auth);
    const myMajors = await this.myMajors(personId);
    const major = this.pick(myMajors, query.majorId && query.majorId.length > 0 ? query.majorId : undefined);
    const onlyMine = !!query.majorId || query.filter === "mine"; // 选了某个专业（或旧的"只看我的专业"）：只列这个专业方案里的课
    const sections = await this.db.section.findMany({ where: { status: "open", term: { status: { in: ["enrolling", "in_progress"] } } }, include: { course: true, term: true, campus: true, instructors: true }, orderBy: { name: "asc" } });
    const mine = await this.db.enrollment.findMany({ where: { studentPersonId: personId, status: { in: ["enrolled", "completed"] } }, include: { section: true } });
    const passedCourses = new Set(mine.filter((e) => e.passed).map((e) => e.section.courseId));
    const activeCourses = new Set(mine.filter((e) => e.status === "enrolled").map((e) => e.section.courseId));
    const names = new Map((await this.db.person.findMany({ where: { id: { in: sections.flatMap((s) => s.instructors.map((i) => i.personId)) } }, select: { id: true, fullName: true } })).map((p) => [p.id, p.fullName]));
    const prereqs = await this.db.coursePrerequisite.findMany({ include: { prerequisite: true } });
    const rows = [];
    for (const s of sections) {
      const requirement = major?.items.get(s.courseId)?.category ?? null;
      if (onlyMine && !requirement) continue;
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
    return { declaredMajor: major ? { id: major.major.id, name: major.major.name } : null, majors: myMajors.map((m) => ({ id: m.major.id, name: m.major.name, kind: m.row.kind })), sections: rows };
  }

  /**
   * 课程详情：学生选课前要看清这门课是什么（简介、先修、上课时间、老师、剩余名额），选上之后也要能回头看。
   * 能看的班：正在开放选课的班，或自己选过的班（含已结课、已退课的）；其他 id 一律 404。
   */
  @Get("sections/:id")
  @RequirePermissions(PERMS.portalEnrollList)
  async sectionDetail(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const { personId } = await this.me(auth);
    const section = await this.db.section.findUnique({ where: { id }, include: { course: true, term: true, campus: true, instructors: true } });
    if (!section) throw new NotFoundException();
    const mine = await this.db.enrollment.findMany({ where: { studentPersonId: personId }, include: { section: true } });
    const myEnrollment = mine.find((e) => e.sectionId === id && ["enrolled", "completed", "withdrawn"].includes(e.status)) ?? null;
    const openForEnrollment = section.status === "open" && ["enrolling", "in_progress"].includes(section.term.status);
    if (!openForEnrollment && !myEnrollment) throw new NotFoundException();
    const passed = new Set(mine.filter((e) => e.passed && ["enrolled", "completed"].includes(e.status)).map((e) => e.section.courseId));
    const prereqs = await this.db.coursePrerequisite.findMany({ where: { courseId: section.courseId }, include: { prerequisite: true } });
    const names = new Map((await this.db.person.findMany({ where: { id: { in: section.instructors.map((i) => i.personId) } }, select: { id: true, fullName: true } })).map((p) => [p.id, p.fullName]));
    const seated = await this.db.enrollment.count({ where: { sectionId: id, status: "enrolled" } });
    const major = this.pick(await this.myMajors(personId));
    return {
      id: section.id,
      name: section.name,
      course: { id: section.courseId, code: section.course.code, name: section.course.name, credits: Number(section.course.credits), syllabus: section.course.syllabus },
      term: { name: section.term.name, startDate: section.term.startDate.toISOString().slice(0, 10), endDate: section.term.endDate.toISOString().slice(0, 10) },
      campus: section.campus.name,
      mode: section.mode,
      schedule: section.schedule,
      notes: section.notes,
      capacity: section.capacity,
      seatsLeft: Math.max(0, section.capacity - seated),
      instructors: section.instructors.map((i) => ({ role: i.role, fullName: names.get(i.personId) ?? null })),
      prerequisites: prereqs.map((p) => ({ code: p.prerequisite.code, name: p.prerequisite.name, met: passed.has(p.prerequisiteId) })),
      requirement: major?.items.get(section.courseId)?.category ?? null,
      myEnrollment: myEnrollment ? { id: myEnrollment.id, status: myEnrollment.status } : null,
    };
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

  /**
   * 培养方案：我的某个专业（默认主修）的课程设置，每门课标注 未开始 / 进行中 / 已通过 和前置课；学分进度只统计已通过的课程。
   * 状态每次按当前的选课记录和培养方案实时算，不存冗余的状态；不判断"能不能修"，也不做毕业审核。
   */
  @Get("plan")
  @RequirePermissions(PERMS.portalPlanView)
  async plan(@Auth() auth: AuthContext, @Query() query: { majorId?: string }) {
    const { personId } = await this.me(auth);
    const myMajors = await this.myMajors(personId);
    const majors = myMajors.map((m) => ({ id: m.major.id, name: m.major.name, kind: m.row.kind }));
    const chosen = this.pick(myMajors, query.majorId && query.majorId.length > 0 ? query.majorId : undefined);
    if (!chosen) return { majors, selected: null, message: "You have not chosen a major yet", credits: { earned: 0, required: 0 }, categories: [], elective: { earned: 0, min: 0 }, courses: [] };
    const { major, version, row, items } = chosen;
    const taken = await this.db.enrollment.findMany({ where: { studentPersonId: personId, status: { in: ["enrolled", "completed"] } }, include: { section: true } });
    const passedCourses = new Set(taken.filter((e) => e.passed).map((e) => e.section.courseId));
    const courses = await this.db.course.findMany({ where: { id: { in: [...items.keys()] } }, orderBy: { code: "asc" } });
    const prereqs = await this.db.coursePrerequisite.findMany({ where: { courseId: { in: courses.map((c) => c.id) } }, include: { prerequisite: true } });
    const list = courses.map((c) => {
      const state = passedCourses.has(c.id) ? "passed" : taken.some((e) => e.section.courseId === c.id && e.status === "enrolled") ? "in_progress" : "not_started";
      return {
        courseId: c.id, code: c.code, name: c.name, credits: Number(c.credits), category: items.get(c.id)?.category ?? "elective", state,
        prerequisites: prereqs.filter((p) => p.courseId === c.id).map((p) => ({ code: p.prerequisite.code, name: p.prerequisite.name, passed: passedCourses.has(p.prerequisiteId) })),
      };
    });
    const order = { in_progress: 0, not_started: 1, passed: 2 } as const;
    list.sort((a, b) => order[a.state as keyof typeof order] - order[b.state as keyof typeof order] || a.code.localeCompare(b.code));
    const sum = (xs: typeof list) => xs.reduce((n, c) => n + c.credits, 0);
    const categories = ["required", "elective", "general"].map((category) => {
      const inCat = list.filter((c) => c.category === category);
      return { category, earned: sum(inCat.filter((c) => c.state === "passed")), planned: sum(inCat) };
    }).filter((c) => c.planned > 0);
    const dept = major.deptId ? await this.db.dept.findUnique({ where: { id: major.deptId }, select: { name: true } }) : null;
    return {
      majors,
      selected: {
        id: major.id, kind: row.kind, code: major.code, name: major.name, degreeType: major.degreeType, department: dept?.name ?? null, description: major.description,
        entryYear: row.entryYear, declaredOn: row.declaredOn.toISOString().slice(0, 10),
        version: version ? { id: version.id, label: version.label, effectiveYear: version.effectiveYear } : null,
      },
      credits: { earned: sum(list.filter((c) => c.state === "passed")), required: Number(version?.totalCredits ?? major.totalCredits) },
      categories,
      elective: { earned: sum(list.filter((c) => c.state === "passed" && c.category === "elective")), min: Number(version?.electiveMinCredits ?? major.electiveMinCredits) },
      courses: list,
    };
  }

  /**
   * 课程信息（培养方案里点课程名）：学分、简介、前置课、在我各个专业里的类别。
   * 能看的课：我任一专业的培养方案里有的，或我选过的；其他一律 404。
   */
  @Get("courses/:id")
  @RequirePermissions(PERMS.portalPlanView)
  async courseInfo(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const { personId } = await this.me(auth);
    const myMajors = await this.myMajors(personId);
    const inPlan = myMajors.filter((m) => m.items.has(id));
    const taken = await this.db.enrollment.findMany({ where: { studentPersonId: personId, status: { in: ["enrolled", "completed", "withdrawn"] } }, include: { section: true } });
    if (inPlan.length === 0 && !taken.some((e) => e.section.courseId === id)) throw new NotFoundException();
    const course = await this.db.course.findUnique({ where: { id } });
    if (!course) throw new NotFoundException();
    const passed = new Set(taken.filter((e) => e.passed && e.status !== "withdrawn").map((e) => e.section.courseId));
    const prereqs = await this.db.coursePrerequisite.findMany({ where: { courseId: id }, include: { prerequisite: true } });
    return {
      id: course.id, code: course.code, name: course.name, credits: Number(course.credits), syllabus: course.syllabus,
      prerequisites: prereqs.map((p) => ({ code: p.prerequisite.code, name: p.prerequisite.name, passed: passed.has(p.prerequisiteId) })),
      majors: inPlan.map((m) => ({ id: m.major.id, name: m.major.name, category: m.items.get(id)?.category })),
    };
  }

  /** 班级课件：选课的学生可看已发布的（已作废/退课的失去访问；结课后保留只读）。 */
  @Get("sections/:id/materials")
  @RequirePermissions(PERMS.portalEnrollList)
  async materials(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const { personId } = await this.me(auth);
    const member = await this.db.enrollment.findFirst({ where: { sectionId: id, studentPersonId: personId, status: { in: ["enrolled", "completed"] } } });
    if (!member) throw new NotFoundException();
    const rows = await this.db.sectionMaterial.findMany({ where: { sectionId: id, published: true }, orderBy: [{ sort: "asc" }, { createdAt: "asc" }] });
    const files = rows.length ? await this.db.sectionMaterialFile.findMany({ where: { materialId: { in: rows.map((r) => r.id) } }, orderBy: { createdAt: "asc" } }) : [];
    const urls = await Promise.all(files.map((f) => this.store.presignDownload(f.storageKey, f.fileName)));
    return rows.map((r) => ({ ...r, files: files.flatMap((f, i) => (f.materialId === r.id ? [{ id: f.id, fileName: f.fileName, contentType: f.contentType, size: f.size, downloadUrl: urls[i] }] : [])) }));
  }
}
