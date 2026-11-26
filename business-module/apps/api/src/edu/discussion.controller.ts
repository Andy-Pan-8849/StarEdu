// 班级讨论的接口：管理后台一侧（任课教师写、教务看）和学生门户一侧（选课的学生写、休学的看）。
// 两边路径形状相同（sections/:id/discussions…），前端用同一个面板。
import { Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { withScope } from "../data-scope/scope-filter";
import { HrAccess } from "../hr/hr-access.service";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { DiscussionService, type DiscussionActor } from "./discussion.service";
import { SECTION_SCOPE } from "./edu-common";

const postSchema = z.object({ title: z.string().max(200), body: z.string().max(5000) });
const replySchema = z.object({ body: z.string().max(5000) });
const pinSchema = z.object({ pinned: z.boolean() });
const resolveSchema = z.object({ resolved: z.boolean() });

@Controller("api/sections")
export class DiscussionController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly hr: HrAccess,
    private readonly discussion: DiscussionService,
  ) {}

  private get db() {
    return this.tenantDb.db;
  }

  /** 班级在数据范围内才有；写需要是任课教师（权限之外再核对一次）。 */
  private async actor(auth: AuthContext, sectionId: string, perm: string, write: boolean): Promise<DiscussionActor> {
    const scope = await this.hr.scope(auth, perm);
    if (!(await this.db.section.findFirst({ where: withScope({ id: sectionId }, scope, SECTION_SCOPE), select: { id: true } }))) throw new NotFoundException();
    const personId = auth.authz.personId;
    const instructor = !!personId && !!(await this.db.sectionInstructor.findFirst({ where: { sectionId, personId } }));
    if (write && !instructor) throw new ForbiddenException("Only the section's instructors may do this");
    return { personId, instructor, activeStudent: false };
  }

  @Get(":id/discussions")
  @RequirePermissions(PERMS.eduDiscussionList)
  async list(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.discussion.list(id, await this.actor(auth, id, PERMS.eduDiscussionList, false));
  }

  @Get(":id/discussions/:postId")
  @RequirePermissions(PERMS.eduDiscussionList)
  async get(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Param("postId", ParseUUIDPipe) postId: string) {
    return this.discussion.get(id, postId, await this.actor(auth, id, PERMS.eduDiscussionList, false));
  }

  @Post(":id/discussions")
  @RequirePermissions(PERMS.eduDiscussionEdit)
  async create(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.discussion.create(auth, id, await this.actor(auth, id, PERMS.eduDiscussionEdit, true), parse(postSchema, body));
  }

  @Post(":id/discussions/:postId/replies")
  @RequirePermissions(PERMS.eduDiscussionEdit)
  async reply(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Param("postId", ParseUUIDPipe) postId: string, @Body() body: unknown) {
    return this.discussion.reply(auth, id, postId, await this.actor(auth, id, PERMS.eduDiscussionEdit, true), parse(replySchema, body).body);
  }

  @Post(":id/discussions/:postId/pin")
  @RequirePermissions(PERMS.eduDiscussionEdit)
  async pin(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Param("postId", ParseUUIDPipe) postId: string, @Body() body: unknown) {
    return this.discussion.pin(id, postId, await this.actor(auth, id, PERMS.eduDiscussionEdit, true), parse(pinSchema, body).pinned);
  }

  @Post(":id/discussions/:postId/resolve")
  @RequirePermissions(PERMS.eduDiscussionEdit)
  async resolve(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Param("postId", ParseUUIDPipe) postId: string, @Body() body: unknown) {
    return this.discussion.resolve(id, postId, await this.actor(auth, id, PERMS.eduDiscussionEdit, true), parse(resolveSchema, body).resolved);
  }

  @Delete(":id/discussions/:postId")
  @RequirePermissions(PERMS.eduDiscussionEdit)
  async remove(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Param("postId", ParseUUIDPipe) postId: string) {
    return this.discussion.remove(id, postId, await this.actor(auth, id, PERMS.eduDiscussionEdit, true));
  }
}

@Controller("api/portal/sections")
export class PortalDiscussionController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly discussion: DiscussionService,
  ) {}

  private get db() {
    return this.tenantDb.db;
  }

  /** 我是这个班的学生（已选或已完成）才能看；已选且在读才能写。 */
  private async actor(auth: AuthContext, sectionId: string): Promise<DiscussionActor> {
    const personId = auth.authz.personId;
    const profile = personId ? await this.db.studentProfile.findFirst({ where: { personId } }) : null;
    if (!personId || !profile) throw new ForbiddenException("This area is for students");
    if (profile.academicStatus !== "enrolled" && profile.academicStatus !== "on_leave") throw new ForbiddenException("Class content is not available for your student status");
    const seat = await this.db.enrollment.findFirst({ where: { sectionId, studentPersonId: personId, status: { in: ["enrolled", "completed"] } } });
    if (!seat) throw new NotFoundException();
    return { personId, instructor: false, activeStudent: seat.status === "enrolled" && profile.academicStatus === "enrolled" };
  }

  @Get(":id/discussions")
  @RequirePermissions(PERMS.portalDiscussionList)
  async list(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.discussion.list(id, await this.actor(auth, id));
  }

  @Get(":id/discussions/:postId")
  @RequirePermissions(PERMS.portalDiscussionList)
  async get(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Param("postId", ParseUUIDPipe) postId: string) {
    return this.discussion.get(id, postId, await this.actor(auth, id));
  }

  @Post(":id/discussions")
  @RequirePermissions(PERMS.portalDiscussionPost)
  async create(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.discussion.create(auth, id, await this.actor(auth, id), parse(postSchema, body));
  }

  @Post(":id/discussions/:postId/replies")
  @RequirePermissions(PERMS.portalDiscussionPost)
  async reply(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Param("postId", ParseUUIDPipe) postId: string, @Body() body: unknown) {
    return this.discussion.reply(auth, id, postId, await this.actor(auth, id), parse(replySchema, body).body);
  }

  @Post(":id/discussions/:postId/resolve")
  @RequirePermissions(PERMS.portalDiscussionPost)
  async resolve(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Param("postId", ParseUUIDPipe) postId: string, @Body() body: unknown) {
    return this.discussion.resolve(id, postId, await this.actor(auth, id), parse(resolveSchema, body).resolved);
  }

  @Delete(":id/discussions/:postId")
  @RequirePermissions(PERMS.portalDiscussionPost)
  async remove(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Param("postId", ParseUUIDPipe) postId: string) {
    return this.discussion.remove(id, postId, await this.actor(auth, id));
  }
}

/** 学生的"讨论"页：我所有班级里的讨论放在一起，未读的排在最前；页面里再按班级筛选。 */
@Controller("api/portal/discussions")
export class PortalAllDiscussionsController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly discussion: DiscussionService,
  ) {}

  private get db() {
    return this.tenantDb.db;
  }

  @Get()
  @RequirePermissions(PERMS.portalDiscussionList)
  async list(@Auth() auth: AuthContext) {
    const personId = auth.authz.personId;
    const profile = personId ? await this.db.studentProfile.findFirst({ where: { personId } }) : null;
    if (!personId || !profile) throw new ForbiddenException("This area is for students");
    if (profile.academicStatus !== "enrolled" && profile.academicStatus !== "on_leave") throw new ForbiddenException("Class content is not available for your student status");
    // 和单个班级的接口同一条规则：已选或已完成的班
    const seats = await this.db.enrollment.findMany({ where: { studentPersonId: personId, status: { in: ["enrolled", "completed"] } }, select: { sectionId: true } });
    const sections = await this.db.section.findMany({ where: { id: { in: [...new Set(seats.map((s) => s.sectionId))] } }, select: { id: true, name: true }, orderBy: { name: "asc" } });
    return this.discussion.listAll(sections, { personId, instructor: false, activeStudent: false });
  }
}
