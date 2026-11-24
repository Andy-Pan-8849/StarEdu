// 学生门户：我的作业。看已发布的作业、拿预签名地址上传文件、提交（截止前可多次，以最后一次为准）、看自己的得分。
//   - 在读（enrolled）可交；休学（on_leave）只读；毕业/退学/结业是成绩单模式，看不到班级内容。
//   - 只有"已选"的班级才能交；班级结课后只读。得分发布后才可见，之前只看到"已提交/批改中"。
//   - 截止以服务器收到的时间为准，按截止日 23:59（班级所属校区的时区），加上给我的延期。
import { QuotaService } from "../quota/quota.service";
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { Prisma } from "../generated/prisma";
import { assertTenantKey, ObjectStoreService, safeKeyPart, tenantPrefix, validateUpload } from "../storage/object-store.service";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { ParamsService } from "../sysdata/params.service";
import { effectiveDeadline, lateness, num } from "./assignment-common";
import { dayString } from "./edu-common";
import { OutboxService } from "./outbox.service";

const MAX_PENDING_UPLOADS = 20;
const uploadSchema = z.object({ fileName: z.string().min(1).max(300), contentType: z.string().trim().min(1).max(100), size: z.number().int() });
const submitSchema = z.object({ text: z.string().max(50000).optional(), fileIds: z.array(z.string().uuid()).max(50).optional() });

@Controller("api/portal/assignments")
export class PortalAssignmentsController {
  constructor(
    private readonly params: ParamsService,
    private readonly tenantDb: TenantPrismaService,
    private readonly store: ObjectStoreService,
    private readonly quota: QuotaService,
    private readonly outbox: OutboxService,
  ) {}

  private get db() {
    return this.tenantDb.db;
  }

  private async me(auth: AuthContext) {
    const personId = auth.authz.personId;
    const profile = personId ? await this.db.studentProfile.findFirst({ where: { personId } }) : null;
    if (!personId || !profile) throw new ForbiddenException("This area is for students");
    if (profile.academicStatus !== "enrolled" && profile.academicStatus !== "on_leave") throw new ForbiddenException("Class content is not available for your student status");
    return { personId, status: profile.academicStatus };
  }

  /** 我能看到的作业：我在这个班（已选或已完成）、作业已发布。 */
  private async visible(personId: string, assignmentId: string) {
    const a = await this.db.assignment.findFirst({ where: { id: assignmentId, published: true, section: { enrollments: { some: { studentPersonId: personId, status: { in: ["enrolled", "completed"] } } } } }, include: { rubric: { orderBy: [{ sort: "asc" }, { id: "asc" }] }, section: { include: { course: true } }, group: true } });
    if (!a) throw new NotFoundException();
    return a;
  }

  /** 现在能不能交：在读、"已选"（不是已完成）、班级没结课取消、没过截止或允许迟交。 */
  private async assertCanSubmit(auth: AuthContext, a: Awaited<ReturnType<PortalAssignmentsController["visible"]>>, personId: string, status: string, at: Date) {
    if (a.manualOnly) throw new ConflictException("This assignment is scored by the teacher; there is nothing to submit");
    if (status !== "enrolled") throw new ForbiddenException("You are on leave; assignments are read-only");
    if (a.section.status === "ended" || a.section.status === "cancelled") throw new ConflictException(`The section is ${a.section.status}`);
    if (!(await this.db.enrollment.findFirst({ where: { sectionId: a.sectionId, studentPersonId: personId, status: "enrolled" } }))) throw new ConflictException("You are not enrolled in this section");
    const ext = await this.db.assignmentExtension.findFirst({ where: { assignmentId: a.id, studentPersonId: personId } });
    const l = lateness(a, ext?.days, at);
    if (l.isLate && !a.allowLate) throw new ConflictException("The deadline has passed and this assignment does not accept late work");
    return { ext, late: l };
  }

  @Get()
  @RequirePermissions(PERMS.portalAssignmentList)
  async list(@Auth() auth: AuthContext) {
    const { personId } = await this.me(auth);
    const rows = await this.db.assignment.findMany({
      where: { published: true, section: { status: { not: "cancelled" }, enrollments: { some: { studentPersonId: personId, status: { in: ["enrolled", "completed"] } } } } },
      include: { section: { include: { course: true } } },
      orderBy: [{ dueAt: "asc" }],
    });
    const [subs, exts] = await Promise.all([this.db.submission.findMany({ where: { studentPersonId: personId, assignmentId: { in: rows.map((r) => r.id) } } }), this.db.assignmentExtension.findMany({ where: { studentPersonId: personId, assignmentId: { in: rows.map((r) => r.id) } } })]);
    const sub = new Map(subs.map((s) => [s.assignmentId, s]));
    const ext = new Map(exts.map((e) => [e.assignmentId, e.days]));
    return rows.map((a) => {
      const s = sub.get(a.id);
      return {
        id: a.id, title: a.title, section: { id: a.sectionId, name: a.section.name, course: a.section.course.name }, dueDate: dayString(a.dueDate), deadline: effectiveDeadline(a.dueAt, ext.get(a.id)), extensionDays: ext.get(a.id) ?? 0,
        allowLate: a.allowLate, maxScore: num(a.maxScore), status: s?.status ?? "missing", submittedAt: s?.submittedAt ?? null, isLate: s?.isLate ?? false,
        finalScore: s?.status === "published" ? num(s.finalScore) : null,
      };
    });
  }

  @Get(":id")
  @RequirePermissions(PERMS.portalAssignmentList)
  async get(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const { personId, status } = await this.me(auth);
    const a = await this.visible(personId, id);
    const [s, ext] = await Promise.all([
      this.db.submission.findFirst({ where: { assignmentId: id, studentPersonId: personId }, include: { versions: { orderBy: { version: "asc" }, include: { files: true } }, scores: true } }),
      this.db.assignmentExtension.findFirst({ where: { assignmentId: id, studentPersonId: personId } }),
    ]);
    const published = s?.status === "published";
    const versions = s
      ? await Promise.all(s.versions.map(async (v) => ({ version: v.version, textAnswer: v.textAnswer, submittedAt: v.submittedAt, isLate: v.isLate, files: await Promise.all(v.files.map(async (f) => ({ id: f.id, fileName: f.fileName, size: f.size, downloadUrl: await this.store.presignDownload(f.storageKey, f.fileName) }))) })))
      : [];
    const deadline = effectiveDeadline(a.dueAt, ext?.days);
    const canSubmit = !a.manualOnly && status === "enrolled" && a.section.status !== "ended" && a.section.status !== "cancelled" && (!s || s.status === "submitted") && (a.allowLate || new Date() <= deadline);
    return {
      id: a.id, title: a.title, description: a.description, attachments: a.attachments, section: { id: a.sectionId, name: a.section.name, course: a.section.course.name }, group: a.group?.name ?? null,
      dueDate: dayString(a.dueDate), deadline, extension: ext ? { days: ext.days, reason: ext.reason } : null, allowLate: a.allowLate, latePolicy: a.latePolicy, maxScore: num(a.maxScore),
      rubric: a.rubric.map((r) => ({ id: r.id, title: r.title, description: r.description, maxPoints: Number(r.maxPoints) })),
      limits: { maxFiles: await this.params.int("edu.submission.maxFiles") },
      canSubmit,
      submission: s
        ? {
            status: s.status, currentVersion: s.currentVersion, submittedAt: s.submittedAt, isLate: s.isLate, hoursLate: num(s.hoursLate), latePenaltyPct: s.latePenaltyPct, versions,
            // 得分发布后才可见
            result: published ? { rawScore: num(s.rawScore), latePenaltyPct: s.latePenaltyPct, finalScore: num(s.finalScore), feedback: s.feedback, scores: s.scores.map((x) => ({ rubricItemId: x.rubricItemId, points: Number(x.points), comment: x.comment })) } : null,
          }
        : null,
    };
  }

  /** 第一步：登记要传的文件（校验类型、大小），拿到预签名上传地址；浏览器直接传给对象存储。 */
  @Post(":id/uploads")
  @RequirePermissions(PERMS.portalAssignmentSubmit)
  async upload(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(uploadSchema, body);
    const { personId, status } = await this.me(auth);
    const a = await this.visible(personId, id);
    await this.assertCanSubmit(auth, a, personId, status, new Date());
    const fileName = validateUpload(input, await this.params.uploadLimitBytes("edu.upload.maxMb", "UPLOAD_MAX_BYTES"));
    await this.quota.assertCanStore(input.size);
    if ((await this.db.submissionFile.count({ where: { assignmentId: id, studentPersonId: personId, versionId: null } })) >= MAX_PENDING_UPLOADS) throw new ConflictException("Too many unfinished uploads; submit or wait");
    const key = `${tenantPrefix(auth.tenantId)}submissions/${id}/${personId}/${randomUUID()}/${safeKeyPart(fileName)}`;
    const file = await this.db.submissionFile.create({ data: { tenantId: auth.tenantId, assignmentId: id, studentPersonId: personId, storageKey: key, fileName, contentType: input.contentType, size: input.size } });
    const signed = await this.store.presignUpload(key, input.contentType, input.size);
    return { fileId: file.id, fileName, uploadUrl: signed.url, method: "PUT", headers: signed.headers, expiresInSeconds: signed.expiresInSeconds };
  }

  /** 第二步：提交。文本和文件至少要有一样；文件必须已经传好（服务端查对象存在、大小一致）。再交一次就是新版本，旧版本保留。 */
  @Post(":id/submissions")
  @RequirePermissions(PERMS.portalAssignmentSubmit)
  async submit(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(submitSchema, body);
    const text = input.text?.trim() ? input.text : null;
    const fileIds = [...new Set(input.fileIds ?? [])];
    const maxFiles = await this.params.int("edu.submission.maxFiles");
    if (fileIds.length > maxFiles) throw new BadRequestException(`At most ${maxFiles} files per submission`);
    if (!text && fileIds.length === 0) throw new BadRequestException("Add an answer or at least one file");
    const { personId, status } = await this.me(auth);
    const a = await this.visible(personId, id);
    const now = new Date();
    const { late } = await this.assertCanSubmit(auth, a, personId, status, now);

    const files = fileIds.length ? await this.db.submissionFile.findMany({ where: { id: { in: fileIds }, assignmentId: id, studentPersonId: personId, versionId: null } }) : [];
    if (files.length !== fileIds.length) throw new BadRequestException("Unknown or already used file");
    for (const f of files) {
      assertTenantKey(auth.tenantId, f.storageKey);
      const head = await this.store.head(f.storageKey);
      if (!head) throw new BadRequestException(`"${f.fileName}" was not uploaded`);
      if (head.size !== f.size) throw new BadRequestException(`"${f.fileName}" does not match the size you declared`);
    }

    const existing = await this.db.submission.findFirst({ where: { assignmentId: id, studentPersonId: personId } });
    if (existing && existing.status !== "submitted") throw new ConflictException("Your submission is being graded or already graded; it can no longer change");
    const hours = new Prisma.Decimal(late.hours.toFixed(2));
    try {
      const result = await this.tenantDb.transaction(async (tx) => {
        const sub = existing
          ? await tx.submission.update({ where: { id: existing.id }, data: { currentVersion: existing.currentVersion + 1, submittedAt: now, isLate: late.isLate, hoursLate: hours, latePenaltyPct: late.pct } })
          : await tx.submission.create({ data: { tenantId: auth.tenantId, assignmentId: id, studentPersonId: personId, submittedAt: now, isLate: late.isLate, hoursLate: hours, latePenaltyPct: late.pct } });
        const version = await tx.submissionVersion.create({ data: { tenantId: auth.tenantId, submissionId: sub.id, version: sub.currentVersion, textAnswer: text, submittedAt: now, isLate: late.isLate } });
        if (files.length) await tx.submissionFile.updateMany({ where: { id: { in: files.map((f) => f.id) } }, data: { versionId: version.id } });
        return { submissionId: sub.id, version: version.version };
      });
      await this.outbox.emit("submission.created", { submissionId: result.submissionId, assignmentId: id, sectionId: a.sectionId, studentPersonId: personId, version: result.version, isLate: late.isLate });
      return { ...result, submittedAt: now, isLate: late.isLate, hoursLate: Number(hours), latePenaltyPct: late.pct };
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw new ConflictException("Another submission was saved at the same time; please try again");
      throw err;
    }
  }
}
