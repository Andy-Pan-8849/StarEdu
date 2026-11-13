// 班级的作业：分组、作业、评分标准、延期、提交与批改（教师和教务一侧）。
//   - 看（作业、提交）：在数据范围内的班级；教师只看自己任教的班，教务按校区。
//   - 建改作业、批改、发布分数：权限 + 必须是该班的任课教师（教务没有这一项）。
//   - 延期：任课教师或教务（权限 + 范围）。
//   - 班级结课或取消后，作业和分数只读（改动要走教务的成绩修改流程，B8）。
import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put } from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { AuditService } from "../audit/audit.service";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { withScope } from "../data-scope/scope-filter";
import { Prisma } from "../generated/prisma";
import { HrAccess } from "../hr/hr-access.service";
import { ObjectStoreService } from "../storage/object-store.service";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { createAssignmentSchema, effectiveDeadline, num, patchAssignmentSchema, pointsInput, recomputeLateness, rubricSchema } from "./assignment-common";
import { dayString, SECTION_SCOPE } from "./edu-common";
import { endOfLocalDay } from "./deadline";
import { applyPenalty, DEFAULT_LATE_POLICY } from "./late-penalty";
import { OutboxService } from "./outbox.service";

const groupSchema = z.object({ name: z.string().trim().min(1).max(100), sort: z.number().int().min(0).max(1000).optional() });
const gradeSchema = z.object({
  scores: z.array(z.object({ rubricItemId: z.string().uuid(), points: pointsInput, comment: z.string().trim().max(1000).nullable().optional() })).max(30),
  feedback: z.string().trim().max(5000).nullable().optional(),
});
const extensionSchema = z.object({ days: z.number().int().min(1).max(3), reason: z.string().trim().min(3).max(500) });

@Controller("api/sections")
export class AssignmentsController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly hr: HrAccess,
    private readonly audit: AuditService,
    private readonly store: ObjectStoreService,
    private readonly outbox: OutboxService,
  ) {}

  private get db() {
    return this.tenantDb.db;
  }

  private async section(auth: AuthContext, sectionId: string, perm: string) {
    const scope = await this.hr.scope(auth, perm);
    const row = await this.db.section.findFirst({ where: withScope({ id: sectionId }, scope, SECTION_SCOPE), include: { campus: true } });
    if (!row) throw new NotFoundException();
    return row;
  }

  private async isInstructor(auth: AuthContext, sectionId: string): Promise<boolean> {
    return !!auth.authz.personId && !!(await this.db.sectionInstructor.findFirst({ where: { sectionId, personId: auth.authz.personId } }));
  }

  /** 改作业、批改：权限 + 范围 + 任课教师，且班级没有结课、取消。 */
  private async editableSection(auth: AuthContext, sectionId: string, perm: string) {
    const row = await this.section(auth, sectionId, perm);
    if (!(await this.isInstructor(auth, sectionId))) throw new ForbiddenException("Only the section's instructors may do this");
    if (row.status === "ended" || row.status === "cancelled") throw new ConflictException(`The section is ${row.status}; assignments and grades are read-only`);
    return row;
  }

  private async assignmentOf(sectionId: string, id: string) {
    const a = await this.db.assignment.findFirst({ where: { id, sectionId }, include: { rubric: { orderBy: [{ sort: "asc" }, { id: "asc" }] }, group: true } });
    if (!a) throw new NotFoundException();
    return a;
  }

  private view(a: Awaited<ReturnType<AssignmentsController["assignmentOf"]>>, extra: Record<string, unknown> = {}) {
    return {
      id: a.id, sectionId: a.sectionId, title: a.title, description: a.description, attachments: a.attachments, dueDate: dayString(a.dueDate), dueAt: a.dueAt,
      allowLate: a.allowLate, manualOnly: a.manualOnly, latePolicy: a.latePolicy, maxScore: num(a.maxScore), published: a.published, publishedAt: a.publishedAt,
      group: a.group ? { id: a.group.id, name: a.group.name } : null,
      rubric: a.rubric.map((r) => ({ id: r.id, title: r.title, description: r.description, maxPoints: Number(r.maxPoints), sort: r.sort })),
      ...extra,
    };
  }

  private async replaceRubric(tx: Prisma.TransactionClient, tenantId: string, assignmentId: string, items: z.infer<typeof rubricSchema>) {
    await tx.rubricItem.deleteMany({ where: { assignmentId } });
    if (items.length) await tx.rubricItem.createMany({ data: items.map((r, i) => ({ tenantId, assignmentId, title: r.title, description: r.description ?? null, maxPoints: new Prisma.Decimal(r.maxPoints), sort: i })) });
    const total = items.reduce((sum, r) => sum.plus(r.maxPoints), new Prisma.Decimal(0));
    await tx.assignment.update({ where: { id: assignmentId }, data: { maxScore: total } });
  }

  // ------------------------------------------------------------ 分组
  @Get(":id/assignment-groups")
  @RequirePermissions(PERMS.eduAssignmentList)
  async groups(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) sectionId: string) {
    await this.section(auth, sectionId, PERMS.eduAssignmentList);
    return this.db.assignmentGroup.findMany({ where: { sectionId }, orderBy: [{ sort: "asc" }, { name: "asc" }] });
  }

  @Post(":id/assignment-groups")
  @RequirePermissions(PERMS.eduAssignmentEdit)
  async addGroup(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) sectionId: string, @Body() body: unknown) {
    const input = parse(groupSchema, body);
    await this.editableSection(auth, sectionId, PERMS.eduAssignmentEdit);
    try {
      return await this.db.assignmentGroup.create({ data: { tenantId: auth.tenantId, sectionId, name: input.name, sort: input.sort ?? 0 } });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw new ConflictException("This section already has a group with that name");
      throw err;
    }
  }

  @Patch(":id/assignment-groups/:groupId")
  @RequirePermissions(PERMS.eduAssignmentEdit)
  async updateGroup(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) sectionId: string, @Param("groupId", ParseUUIDPipe) groupId: string, @Body() body: unknown) {
    const input = parse(groupSchema.partial().strict(), body);
    await this.editableSection(auth, sectionId, PERMS.eduAssignmentEdit);
    if (!(await this.db.assignmentGroup.findFirst({ where: { id: groupId, sectionId } }))) throw new NotFoundException();
    try {
      return await this.db.assignmentGroup.update({ where: { id: groupId }, data: input });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw new ConflictException("This section already has a group with that name");
      throw err;
    }
  }

  @Delete(":id/assignment-groups/:groupId")
  @RequirePermissions(PERMS.eduAssignmentEdit)
  async removeGroup(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) sectionId: string, @Param("groupId", ParseUUIDPipe) groupId: string) {
    await this.editableSection(auth, sectionId, PERMS.eduAssignmentEdit);
    if (await this.db.assignment.count({ where: { groupId } })) throw new ConflictException("Assignments still belong to this group");
    const { count } = await this.db.assignmentGroup.deleteMany({ where: { id: groupId, sectionId } });
    if (!count) throw new NotFoundException();
    return { id: groupId };
  }

  // ------------------------------------------------------------ 作业
  @Get(":id/assignments")
  @RequirePermissions(PERMS.eduAssignmentList)
  async list(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) sectionId: string) {
    await this.section(auth, sectionId, PERMS.eduAssignmentList);
    const rows = await this.db.assignment.findMany({ where: { sectionId }, include: { rubric: { orderBy: [{ sort: "asc" }, { id: "asc" }] }, group: true }, orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }] });
    const subs = await this.db.submission.groupBy({ by: ["assignmentId", "status"], where: { assignmentId: { in: rows.map((r) => r.id) } }, _count: true });
    return rows.map((a) => {
      const mine = subs.filter((s) => s.assignmentId === a.id);
      const count = (st: string) => mine.filter((s) => s.status === st).reduce((n, s) => n + s._count, 0);
      return this.view(a, { counts: { submitted: count("submitted"), grading: count("grading"), published: count("published") } });
    });
  }

  @Get(":id/assignments/:assignmentId")
  @RequirePermissions(PERMS.eduAssignmentList)
  async get(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) sectionId: string, @Param("assignmentId", ParseUUIDPipe) id: string) {
    await this.section(auth, sectionId, PERMS.eduAssignmentList);
    const a = await this.assignmentOf(sectionId, id);
    const extensions = await this.db.assignmentExtension.findMany({ where: { assignmentId: id }, orderBy: { createdAt: "asc" } });
    return this.view(a, { extensions: extensions.map((e) => ({ studentPersonId: e.studentPersonId, days: e.days, reason: e.reason, grantedBy: e.grantedBy, createdAt: e.createdAt })) });
  }

  @Post(":id/assignments")
  @RequirePermissions(PERMS.eduAssignmentEdit)
  async create(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) sectionId: string, @Body() body: unknown) {
    const input = parse(createAssignmentSchema, body);
    const section = await this.editableSection(auth, sectionId, PERMS.eduAssignmentEdit);
    if (input.groupId) await this.checkGroup(sectionId, input.groupId);
    const id = await this.tenantDb.transaction(async (tx) => {
      const a = await tx.assignment.create({
        data: {
          tenantId: auth.tenantId, sectionId, groupId: input.groupId ?? null, title: input.title, description: input.description ?? "", attachments: (input.attachments ?? []) as never,
          dueDate: new Date(`${input.dueDate}T00:00:00Z`), dueAt: endOfLocalDay(input.dueDate, section.campus.timezone), allowLate: input.allowLate ?? true, manualOnly: input.manualOnly ?? false,
          latePolicy: (input.latePolicy ?? DEFAULT_LATE_POLICY) as never, createdBy: auth.accountId,
        },
      });
      if (input.rubric?.length) await this.replaceRubric(tx, auth.tenantId, a.id, input.rubric);
      return a.id;
    });
    await this.audit.record(auth.accountId, "assignment.create", "section", sectionId, { assignmentId: id, title: input.title });
    return this.view(await this.assignmentOf(sectionId, id));
  }

  private async checkGroup(sectionId: string, groupId: string) {
    if (!(await this.db.assignmentGroup.findFirst({ where: { id: groupId, sectionId } }))) throw new BadRequestException("Unknown group");
  }

  @Patch(":id/assignments/:assignmentId")
  @RequirePermissions(PERMS.eduAssignmentEdit)
  async update(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) sectionId: string, @Param("assignmentId", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(patchAssignmentSchema, body);
    const section = await this.editableSection(auth, sectionId, PERMS.eduAssignmentEdit);
    const current = await this.assignmentOf(sectionId, id);
    const timing = input.dueDate !== undefined || input.latePolicy !== undefined || input.allowLate !== undefined;
    if (timing) {
      if (await this.db.submission.count({ where: { assignmentId: id, status: { not: "submitted" } } })) throw new ConflictException("Grading has started; the deadline and late rules can no longer change");
      if (input.allowLate === false && (await this.db.submission.count({ where: { assignmentId: id, isLate: true } }))) throw new ConflictException("Late submissions already exist");
    }
    if (input.groupId) await this.checkGroup(sectionId, input.groupId);
    if (input.manualOnly === true && (await this.db.submission.count({ where: { assignmentId: id } }))) throw new ConflictException("Students have already submitted");
    const { dueDate, latePolicy, attachments, ...rest } = input;
    const data = {
      ...rest,
      ...(attachments ? { attachments: attachments as never } : {}),
      ...(latePolicy ? { latePolicy: latePolicy as never } : {}),
      ...(dueDate ? { dueDate: new Date(`${dueDate}T00:00:00Z`), dueAt: endOfLocalDay(dueDate, section.campus.timezone) } : {}),
    };
    await this.tenantDb.transaction(async (tx) => {
      const next = await tx.assignment.update({ where: { id }, data });
      if (timing) await recomputeLateness(tx, next);
    });
    await this.audit.record(auth.accountId, "assignment.update", "section", sectionId, { assignmentId: id, fields: Object.keys(input), was: { dueDate: dayString(current.dueDate) } });
    return this.view(await this.assignmentOf(sectionId, id));
  }

  /** 整体替换评分标准；满分重新累加。已经有人被打分后不能再改（否则历史分数没有意义）。 */
  @Put(":id/assignments/:assignmentId/rubric")
  @RequirePermissions(PERMS.eduAssignmentEdit)
  async setRubric(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) sectionId: string, @Param("assignmentId", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { items } = parse(z.object({ items: rubricSchema }), body);
    await this.editableSection(auth, sectionId, PERMS.eduAssignmentEdit);
    const a = await this.assignmentOf(sectionId, id);
    if (await this.db.submissionScore.count({ where: { submission: { assignmentId: id } } })) throw new ConflictException("Grading has started; the rubric can no longer change");
    if (a.published && items.length === 0) throw new ConflictException("A published assignment needs a rubric");
    await this.tenantDb.transaction((tx) => this.replaceRubric(tx, auth.tenantId, id, items));
    await this.audit.record(auth.accountId, "assignment.rubric", "section", sectionId, { assignmentId: id, items: items.length });
    return this.view(await this.assignmentOf(sectionId, id));
  }

  /** 发布后学生才看得到、才能提交。要有评分标准；已经有提交就不能撤回发布。 */
  @Post(":id/assignments/:assignmentId/publish")
  @RequirePermissions(PERMS.eduAssignmentEdit)
  async publish(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) sectionId: string, @Param("assignmentId", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { published } = parse(z.object({ published: z.boolean() }), body);
    await this.editableSection(auth, sectionId, PERMS.eduAssignmentEdit);
    const a = await this.assignmentOf(sectionId, id);
    if (a.published === published) throw new ConflictException(published ? "Already published" : "Not published");
    if (published && a.rubric.length === 0) throw new ConflictException("Add a rubric before publishing");
    if (!published && (await this.db.submission.count({ where: { assignmentId: id } }))) throw new ConflictException("Students have already submitted");
    await this.db.assignment.update({ where: { id }, data: { published, publishedAt: published ? new Date() : null } });
    if (published) await this.outbox.emit("assignment.published", { assignmentId: id, sectionId, title: a.title, dueAt: a.dueAt });
    await this.audit.record(auth.accountId, published ? "assignment.publish" : "assignment.unpublish", "section", sectionId, { assignmentId: id });
    return this.view(await this.assignmentOf(sectionId, id));
  }

  @Delete(":id/assignments/:assignmentId")
  @RequirePermissions(PERMS.eduAssignmentEdit)
  async remove(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) sectionId: string, @Param("assignmentId", ParseUUIDPipe) id: string) {
    await this.editableSection(auth, sectionId, PERMS.eduAssignmentEdit);
    await this.assignmentOf(sectionId, id);
    if (await this.db.submission.count({ where: { assignmentId: id } })) throw new ConflictException("Students have already submitted; the assignment cannot be deleted");
    await this.tenantDb.transaction(async (tx) => {
      await tx.assignmentExtension.deleteMany({ where: { assignmentId: id } });
      await tx.rubricItem.deleteMany({ where: { assignmentId: id } });
      await tx.assignment.delete({ where: { id } });
    });
    await this.audit.record(auth.accountId, "assignment.delete", "section", sectionId, { assignmentId: id });
    return { id };
  }

  // ------------------------------------------------------------ 延期
  /** 给某个学生延期 1–3 天（再设一次就是改天数）；记原因和操作人，写审计和操作日志。该学生已被批改就不能再改。 */
  @Put(":id/assignments/:assignmentId/extensions/:studentId")
  @RequirePermissions(PERMS.eduExtensionEdit)
  async extend(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) sectionId: string, @Param("assignmentId", ParseUUIDPipe) id: string, @Param("studentId", ParseUUIDPipe) studentId: string, @Body() body: unknown) {
    const input = parse(extensionSchema, body);
    await this.section(auth, sectionId, PERMS.eduExtensionEdit);
    const a = await this.assignmentOf(sectionId, id);
    const member = await this.db.enrollment.findFirst({ where: { sectionId, studentPersonId: studentId, status: { in: ["enrolled", "completed"] } } });
    if (!member) throw new BadRequestException("The student is not in this section");
    const mine = await this.db.submission.findFirst({ where: { assignmentId: id, studentPersonId: studentId } });
    if (mine && mine.status !== "submitted") throw new ConflictException("This submission is already being graded");
    await this.tenantDb.transaction(async (tx) => {
      await tx.assignmentExtension.upsert({
        where: { assignmentId_studentPersonId: { assignmentId: id, studentPersonId: studentId } },
        create: { tenantId: auth.tenantId, assignmentId: id, studentPersonId: studentId, days: input.days, reason: input.reason, grantedBy: auth.accountId },
        update: { days: input.days, reason: input.reason, grantedBy: auth.accountId },
      });
      await recomputeLateness(tx, a);
    });
    await this.audit.record(auth.accountId, "assignment.extend", "section", sectionId, { assignmentId: id, studentPersonId: studentId, days: input.days, reason: input.reason });
    return { assignmentId: id, studentPersonId: studentId, days: input.days, reason: input.reason, effectiveDeadline: effectiveDeadline(a.dueAt, input.days) };
  }

  @Delete(":id/assignments/:assignmentId/extensions/:studentId")
  @RequirePermissions(PERMS.eduExtensionEdit)
  async cancelExtension(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) sectionId: string, @Param("assignmentId", ParseUUIDPipe) id: string, @Param("studentId", ParseUUIDPipe) studentId: string) {
    await this.section(auth, sectionId, PERMS.eduExtensionEdit);
    const a = await this.assignmentOf(sectionId, id);
    const mine = await this.db.submission.findFirst({ where: { assignmentId: id, studentPersonId: studentId } });
    if (mine && mine.status !== "submitted") throw new ConflictException("This submission is already being graded");
    await this.tenantDb.transaction(async (tx) => {
      const { count } = await tx.assignmentExtension.deleteMany({ where: { assignmentId: id, studentPersonId: studentId } });
      if (!count) throw new NotFoundException();
      await recomputeLateness(tx, a);
    });
    await this.audit.record(auth.accountId, "assignment.extend_cancel", "section", sectionId, { assignmentId: id, studentPersonId: studentId });
    return { assignmentId: id, studentPersonId: studentId };
  }

  // ------------------------------------------------------------ 提交与批改
  /** 名单：班里每个学生一行（没交的也在，状态 missing）。 */
  @Get(":id/assignments/:assignmentId/submissions")
  @RequirePermissions(PERMS.eduSubmissionList)
  async submissions(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) sectionId: string, @Param("assignmentId", ParseUUIDPipe) id: string) {
    await this.section(auth, sectionId, PERMS.eduSubmissionList);
    const a = await this.assignmentOf(sectionId, id);
    const members = await this.db.enrollment.findMany({ where: { sectionId, status: { in: ["enrolled", "completed"] } }, orderBy: { enrolledAt: "asc" } });
    const ids = members.map((m) => m.studentPersonId);
    const [people, profiles, subs, exts] = await Promise.all([
      this.db.person.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } }),
      this.db.studentProfile.findMany({ where: { personId: { in: ids } } }),
      this.db.submission.findMany({ where: { assignmentId: id } }),
      this.db.assignmentExtension.findMany({ where: { assignmentId: id } }),
    ]);
    const name = new Map(people.map((p) => [p.id, p.fullName]));
    const no = new Map(profiles.map((p) => [p.personId, p.studentNo]));
    const sub = new Map(subs.map((s) => [s.studentPersonId, s]));
    const ext = new Map(exts.map((e) => [e.studentPersonId, e]));
    return {
      assignment: this.view(a),
      rows: members.map((m) => {
        const s = sub.get(m.studentPersonId);
        const e = ext.get(m.studentPersonId);
        return {
          studentPersonId: m.studentPersonId, fullName: name.get(m.studentPersonId) ?? null, studentNo: no.get(m.studentPersonId) ?? null,
          submissionId: s?.id ?? null, status: s?.status ?? "missing", submittedAt: s?.submittedAt ?? null, version: s?.currentVersion ?? null, isLate: s?.isLate ?? false, hoursLate: num(s?.hoursLate) ?? 0,
          latePenaltyPct: s?.latePenaltyPct ?? null, rawScore: num(s?.rawScore), finalScore: num(s?.finalScore),
          extension: e ? { days: e.days, reason: e.reason } : null, effectiveDeadline: effectiveDeadline(a.dueAt, e?.days),
        };
      }),
    };
  }

  /** 一份提交的详情：全部版本、每个版本的文件（给 5 分钟有效的下载地址）、逐项得分。 */
  @Get(":id/assignments/:assignmentId/submissions/:subId")
  @RequirePermissions(PERMS.eduSubmissionList)
  async submission(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) sectionId: string, @Param("assignmentId", ParseUUIDPipe) id: string, @Param("subId", ParseUUIDPipe) subId: string) {
    await this.section(auth, sectionId, PERMS.eduSubmissionList);
    await this.assignmentOf(sectionId, id);
    const s = await this.db.submission.findFirst({ where: { id: subId, assignmentId: id }, include: { versions: { orderBy: { version: "asc" }, include: { files: true } }, scores: true } });
    if (!s) throw new NotFoundException();
    const student = await this.db.person.findUnique({ where: { id: s.studentPersonId }, select: { fullName: true } });
    const versions = await Promise.all(
      s.versions.map(async (v) => ({
        version: v.version, textAnswer: v.textAnswer, submittedAt: v.submittedAt, isLate: v.isLate,
        files: await Promise.all(v.files.map(async (f) => ({ id: f.id, fileName: f.fileName, contentType: f.contentType, size: f.size, downloadUrl: await this.store.presignDownload(f.storageKey, f.fileName) }))),
      })),
    );
    return {
      id: s.id, studentPersonId: s.studentPersonId, fullName: student?.fullName ?? null, status: s.status, currentVersion: s.currentVersion, submittedAt: s.submittedAt, isLate: s.isLate, hoursLate: num(s.hoursLate),
      latePenaltyPct: s.latePenaltyPct, rawScore: num(s.rawScore), finalScore: num(s.finalScore), feedback: s.feedback, gradedAt: s.gradedAt, publishedAt: s.publishedAt, versions,
      scores: s.scores.map((x) => ({ rubricItemId: x.rubricItemId, points: Number(x.points), comment: x.comment })),
    };
  }

  /** 逐项打分（可分几次存）：每项不超过该项满分；原始分 = 各项之和，迟交的按扣分表算最终分。发布前随时可改。 */
  @Put(":id/assignments/:assignmentId/submissions/:subId/grade")
  @RequirePermissions(PERMS.eduSubmissionGrade)
  async grade(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) sectionId: string, @Param("assignmentId", ParseUUIDPipe) id: string, @Param("subId", ParseUUIDPipe) subId: string, @Body() body: unknown) {
    const input = parse(gradeSchema, body);
    await this.editableSection(auth, sectionId, PERMS.eduSubmissionGrade);
    const a = await this.assignmentOf(sectionId, id);
    const s = await this.db.submission.findFirst({ where: { id: subId, assignmentId: id } });
    if (!s) throw new NotFoundException();
    if (s.status === "published") throw new ConflictException("The scores are published and can no longer change here");
    const items = new Map(a.rubric.map((r) => [r.id, r]));
    const seen = new Set<string>();
    for (const sc of input.scores) {
      const item = items.get(sc.rubricItemId);
      if (!item) throw new BadRequestException("Unknown rubric item");
      if (seen.has(sc.rubricItemId)) throw new BadRequestException("A rubric item can be scored once");
      seen.add(sc.rubricItemId);
      if (sc.points > Number(item.maxPoints)) throw new BadRequestException(`"${item.title}" is out of ${Number(item.maxPoints)}`);
    }
    const raw = input.scores.reduce((sum, sc) => sum.plus(sc.points), new Prisma.Decimal(0));
    const pct = s.latePenaltyPct ?? 0;
    await this.tenantDb.transaction(async (tx) => {
      await tx.submissionScore.deleteMany({ where: { submissionId: subId } });
      if (input.scores.length) await tx.submissionScore.createMany({ data: input.scores.map((sc) => ({ tenantId: auth.tenantId, submissionId: subId, rubricItemId: sc.rubricItemId, points: new Prisma.Decimal(sc.points), comment: sc.comment ?? null })) });
      await tx.submission.update({
        where: { id: subId },
        data: { status: input.scores.length ? "grading" : "submitted", rawScore: input.scores.length ? raw : null, finalScore: input.scores.length ? applyPenalty(raw, pct) : null, feedback: input.feedback ?? null, gradedBy: auth.accountId, gradedAt: new Date() },
      });
    });
    return this.submission(auth, sectionId, id, subId);
  }

  private async publishable(sectionId: string, assignmentId: string) {
    const a = await this.assignmentOf(sectionId, assignmentId);
    return { a, complete: (s: { scores: Array<{ rubricItemId: string }> }) => a.rubric.length > 0 && a.rubric.every((r) => s.scores.some((x) => x.rubricItemId === r.id)) };
  }

  /** 发布一份提交的分数：评分标准每一项都打过分才能发布；发布后学生可见，这里不能再改。 */
  @Post(":id/assignments/:assignmentId/submissions/:subId/publish")
  @RequirePermissions(PERMS.eduSubmissionGrade)
  async publishOne(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) sectionId: string, @Param("assignmentId", ParseUUIDPipe) id: string, @Param("subId", ParseUUIDPipe) subId: string) {
    await this.editableSection(auth, sectionId, PERMS.eduSubmissionGrade);
    const { complete } = await this.publishable(sectionId, id);
    const s = await this.db.submission.findFirst({ where: { id: subId, assignmentId: id }, include: { scores: true } });
    if (!s) throw new NotFoundException();
    if (s.status === "published") throw new ConflictException("Already published");
    if (!complete(s)) throw new ConflictException("Score every rubric item before publishing");
    await this.db.submission.update({ where: { id: subId }, data: { status: "published", publishedAt: new Date() } });
    await this.outbox.emit("submission.published", { submissionId: subId, assignmentId: id, sectionId, studentPersonId: s.studentPersonId });
    await this.audit.record(auth.accountId, "submission.publish", "section", sectionId, { assignmentId: id, submissionId: subId });
    return this.submission(auth, sectionId, id, subId);
  }

  /** 把这次作业所有已打完分的提交一起发布；没打完的留着。 */
  @Post(":id/assignments/:assignmentId/publish-grades")
  @RequirePermissions(PERMS.eduSubmissionGrade)
  async publishAll(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) sectionId: string, @Param("assignmentId", ParseUUIDPipe) id: string) {
    await this.editableSection(auth, sectionId, PERMS.eduSubmissionGrade);
    const { complete } = await this.publishable(sectionId, id);
    const subs = await this.db.submission.findMany({ where: { assignmentId: id, status: "grading" }, include: { scores: true } });
    const ready = subs.filter(complete);
    for (const s of ready) {
      await this.db.submission.update({ where: { id: s.id }, data: { status: "published", publishedAt: new Date() } });
      await this.outbox.emit("submission.published", { submissionId: s.id, assignmentId: id, sectionId, studentPersonId: s.studentPersonId });
    }
    await this.audit.record(auth.accountId, "submission.publish_all", "section", sectionId, { assignmentId: id, published: ready.length, left: subs.length - ready.length });
    return { published: ready.length, notReady: subs.length - ready.length };
  }
}
