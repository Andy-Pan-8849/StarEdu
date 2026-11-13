// 公告：发给全公司、一个校区或一个班级。发布时就把消息生成给每个收件人（按各人的偏好），
// 所以"阅读名单"就是这批消息的已读情况。教师只能发给自己的班；校区负责人只能发给自己校区；全公司需要"全部"范围。
import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { AuditService } from "../audit/audit.service";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { withScope } from "../data-scope/scope-filter";
import { SECTION_SCOPE } from "../edu/edu-common";
import { HrAccess } from "../hr/hr-access.service";
import { assertVisible } from "../tenancy/owned";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { NotificationService } from "./notification.service";

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
  target: z.discriminatedUnion("kind", [z.object({ kind: z.literal("tenant") }), z.object({ kind: z.literal("campus"), campusId: z.string().uuid() }), z.object({ kind: z.literal("section"), sectionId: z.string().uuid() })]),
});

@Controller("api/announcements")
export class AnnouncementsController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly hr: HrAccess,
    private readonly audit: AuditService,
    private readonly notify: NotificationService,
  ) {}

  private get db() {
    return this.tenantDb.db;
  }

  /** 收件人（账号 id）。 */
  private async recipients(target: z.infer<typeof createSchema>["target"]): Promise<string[]> {
    const accountsOf = async (personIds: string[]) => (await this.db.account.findMany({ where: { personId: { in: personIds }, status: "active", isService: false }, select: { id: true } })).map((a) => a.id);
    if (target.kind === "tenant") return (await this.db.account.findMany({ where: { status: "active", isService: false }, select: { id: true } })).map((a) => a.id);
    if (target.kind === "section") {
      const [teachers, students] = await Promise.all([this.db.sectionInstructor.findMany({ where: { sectionId: target.sectionId }, select: { personId: true } }), this.db.enrollment.findMany({ where: { sectionId: target.sectionId, status: "enrolled" }, select: { studentPersonId: true } })]);
      return accountsOf([...teachers.map((t) => t.personId), ...students.map((s) => s.studentPersonId)]);
    }
    const campus = await this.db.campus.findUnique({ where: { id: target.campusId } });
    const depts = await this.db.dept.findMany({ where: { ancestors: { has: campus?.deptId ?? "" } }, select: { id: true } });
    const [assigned, students] = await Promise.all([this.db.personDept.findMany({ where: { deptId: { in: depts.map((d) => d.id) } }, select: { personId: true } }), this.db.studentProfile.findMany({ where: { campusId: target.campusId }, select: { personId: true } })]);
    return accountsOf([...new Set([...assigned.map((a) => a.personId), ...students.map((s) => s.personId)])]);
  }

  private async mine(auth: AuthContext, id: string) {
    const scope = await this.hr.scope(auth, PERMS.msgAnnouncementList);
    const row = await this.db.announcement.findFirst({ where: { id, ...(scope.all ? {} : { createdBy: auth.accountId }) } });
    if (!row) throw new NotFoundException();
    return row;
  }

  /** 全部范围的人看全部公告；其他人只看自己发的。 */
  @Get()
  @RequirePermissions(PERMS.msgAnnouncementList)
  async list(@Auth() auth: AuthContext) {
    const scope = await this.hr.scope(auth, PERMS.msgAnnouncementList);
    return this.db.announcement.findMany({ where: scope.all ? {} : { createdBy: auth.accountId }, orderBy: { createdAt: "desc" }, take: 100 });
  }

  @Post()
  @RequirePermissions(PERMS.msgAnnouncementAdd)
  async create(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(createSchema, body);
    const scope = await this.hr.scope(auth, PERMS.msgAnnouncementAdd);
    const t = input.target;
    if (t.kind === "tenant" && !scope.all) throw new ForbiddenException("Announcing to the whole company needs the all-data scope");
    if (t.kind === "campus") {
      await assertVisible(this.db.campus, [t.campusId], "campus");
      const campus = await this.db.campus.findUniqueOrThrow({ where: { id: t.campusId } });
      this.hr.assertDeptInScope(scope, campus.deptId);
    }
    if (t.kind === "section" && !(await this.db.section.findFirst({ where: withScope({ id: t.sectionId }, scope, SECTION_SCOPE), select: { id: true } }))) throw new NotFoundException();
    const accountIds = await this.recipients(t);
    if (!accountIds.length) throw new BadRequestException("Nobody is in that audience");
    const a = await this.db.announcement.create({ data: { tenantId: auth.tenantId, title: input.title, body: input.body, scopeKind: t.kind, campusId: t.kind === "campus" ? t.campusId : null, sectionId: t.kind === "section" ? t.sectionId : null, createdBy: auth.accountId } });
    const delivered = await this.notify.deliver(auth.tenantId, "announcement", accountIds.map((accountId) => ({ accountId, type: "announcement", title: input.title, body: input.body })), `announcement:${a.id}`);
    await this.db.announcement.update({ where: { id: a.id }, data: { recipients: accountIds.length } });
    await this.audit.record(auth.accountId, "announcement.publish", "announcement", a.id, { target: t, audience: accountIds.length, delivered });
    return { ...a, recipients: accountIds.length, delivered };
  }

  /** 阅读名单：每个收件人是否读过。 */
  @Get(":id/readers")
  @RequirePermissions(PERMS.msgAnnouncementList)
  async readers(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    await this.mine(auth, id);
    const rows = await this.db.notification.findMany({ where: { dedupeKey: `announcement:${id}` } });
    const accounts = new Map((await this.db.account.findMany({ where: { id: { in: rows.map((r) => r.accountId) } }, select: { id: true, username: true } })).map((a) => [a.id, a.username]));
    return rows.map((r) => ({ accountId: r.accountId, username: accounts.get(r.accountId) ?? null, readAt: r.readAt })).sort((a, b) => String(a.username).localeCompare(String(b.username)));
  }

  /** 撤回：已发出的消息从大家的消息中心撤掉。 */
  @Delete(":id")
  @RequirePermissions(PERMS.msgAnnouncementRemove)
  async withdraw(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const a = await this.mine(auth, id);
    if (a.withdrawnAt) throw new ConflictException("Already withdrawn");
    await this.tenantDb.transaction(async (tx) => {
      await tx.notification.deleteMany({ where: { dedupeKey: `announcement:${id}` } });
      await tx.announcement.update({ where: { id }, data: { withdrawnAt: new Date() } });
    });
    await this.audit.record(auth.accountId, "announcement.withdraw", "announcement", id, {});
    return { id };
  }
}
