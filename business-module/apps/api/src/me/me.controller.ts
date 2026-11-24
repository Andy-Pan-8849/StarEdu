// "我"：登录登记（入口资格检查 + 登录日志 + 在线状态）、我的信息、我的菜单树。
// 这三个接口对任何已登录的本租户账号开放（AnyAuthenticated），数据只涉及账号自己。
import { ParamsService } from "../sysdata/params.service";
import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { AuditService } from "../audit/audit.service";
import { AnyAuthenticated } from "../auth/decorators";
import { SessionStore } from "../auth/session-store";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, ClientInfo, parse } from "../common/http";
import { AuthzService } from "../rbac/authz.service";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";

const profilePatch = z.object({ phone: z.string().trim().max(50).nullable().optional(), workEmail: z.string().trim().email().max(200).nullable().optional() }).strict();
const entrySchema = z.object({ entry: z.enum(["admin", "portal"]) });

@Controller("api")
export class MeController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly authz: AuthzService,
    private readonly sessions: SessionStore,
    private readonly params: ParamsService,
    private readonly audit: AuditService,
  ) {}

  @Get("me")
  @AnyAuthenticated()
  async me(@Auth() auth: AuthContext) {
    const account = await this.tenantDb.db.account.findUnique({ where: { id: auth.accountId } });
    if (!account) throw new NotFoundException("Account not found in this tenant");
    return {
      brand: await this.brand(auth.tenantId),
      settings: await this.params.uiSettings(),
      id: account.id,
      tenantId: account.tenantId,
      username: account.username,
      status: account.status,
      roles: auth.authz.roles.map((r) => ({ id: r.id, code: r.code, kind: r.kind })),
      permissions: auth.authz.perms,
    };
  }

  /**
   * 个人中心：我是谁（姓名、账号、角色、所属部门），以及我自己能改的联系方式（手机、邮箱）。
   * 姓名、学号、部门由教务/人事维护，这里只读；没有对应人员的账号（内置管理员）只显示账号信息。
   */
  @Get("me/profile")
  @AnyAuthenticated()
  async profile(@Auth() auth: AuthContext) {
    const db = this.tenantDb.db;
    const account = await db.account.findUnique({ where: { id: auth.accountId } });
    if (!account) throw new NotFoundException("Account not found in this tenant");
    const person = account.personId ? await db.person.findUnique({ where: { id: account.personId } }) : null;
    const roles = await db.role.findMany({ where: { id: { in: auth.authz.roles.map((r) => r.id) } }, select: { code: true, name: true } });
    const links = person ? await db.personDept.findMany({ where: { personId: person.id, endDate: null }, select: { deptId: true, isPrimary: true } }) : [];
    const depts = links.length ? await db.dept.findMany({ where: { id: { in: links.map((l) => l.deptId) } }, select: { id: true, name: true } }) : [];
    const [staff, student] = person ? await Promise.all([db.staffProfile.findFirst({ where: { personId: person.id } }), db.studentProfile.findFirst({ where: { personId: person.id } })]) : [null, null];
    return {
      username: account.username,
      fullName: person?.fullName ?? null,
      type: person?.type ?? null,
      number: staff?.employeeNo ?? student?.studentNo ?? null,
      email: person?.workEmail ?? account.email ?? null,
      phone: person?.phone ?? null,
      roles: roles.map((r) => ({ code: r.code, name: r.name })),
      depts: depts.map((d) => d.name),
      createdAt: account.createdAt,
      editable: !!person,
    };
  }

  /** 改自己的联系方式（手机、邮箱）。只能改自己的；其余资料由教务/人事维护。 */
  @Patch("me/profile")
  @AnyAuthenticated()
  async updateProfile(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(profilePatch, body);
    const db = this.tenantDb.db;
    const account = await db.account.findUnique({ where: { id: auth.accountId } });
    if (!account?.personId) throw new BadRequestException("This account has no personal profile to edit");
    const person = await db.person.update({ where: { id: account.personId }, data: { ...(input.phone !== undefined ? { phone: input.phone || null } : {}), ...(input.workEmail !== undefined ? { workEmail: input.workEmail || null } : {}), updatedBy: auth.accountId } });
    await this.audit.record(auth.accountId, "profile.update", "person", person.id, { fields: Object.keys(input) });
    return { phone: person.phone, email: person.workEmail };
  }

  // 学生门户的会话走 /api/portal/*，同一个个人中心
  @Get("portal/me/profile")
  @AnyAuthenticated()
  portalProfile(@Auth() auth: AuthContext) {
    return this.profile(auth);
  }

  @Patch("portal/me/profile")
  @AnyAuthenticated()
  portalUpdateProfile(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.updateProfile(auth, body);
  }

  /**
   * 左上角的品牌：名称取公司简称（没有就用公司名）；Logo 取本公司的参数 brand.logoUrl（一个图片网址，
   * 只接受 http(s) 或以 / 开头的地址），没有或不合规就是 null，前端显示默认 Logo。
   */
  private async brand(tenantId: string): Promise<{ name: string; logoUrl: string | null }> {
    const db = this.tenantDb.db;
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { name: true, shortName: true } });
    const params = await db.sysParam.findMany({ where: { key: "brand.logoUrl", deletedAt: null }, select: { value: true, tenantId: true } });
    const own = params.find((p) => p.tenantId === tenantId) ?? params[0];
    const url = own?.value.trim() ?? "";
    return { name: tenant?.shortName?.trim() || tenant?.name || "StarIT", logoUrl: /^(https?:\/\/|\/(?!\/))\S+$/i.test(url) ? url : null };
  }

  /** 某入口下我能看到的菜单树（后台：按角色勾选；门户：学生全部）。 */
  @Get("me/menus")
  @AnyAuthenticated()
  async menus(@Auth() auth: AuthContext, @Query() query: unknown) {
    const { entry } = parse(entrySchema, query);
    await this.assertQualified(auth, entry);
    return this.tree(auth, entry);
  }

  /**
   * 登录登记：前端在 Keycloak 登录回调之后调用。
   *   - 检查"入口资格"（管理后台：内置管理员或教职员工，且至少有一个菜单；学生门户：学生）；
   *   - 通过：待激活的账号在这里变成"正常"（能拿到令牌说明已经设好密码），登记在线状态，写登录日志；
   *   - 不通过：写一条"被拒"的登录日志，返回 403。
   */
  @Post("auth/session")
  @AnyAuthenticated()
  async session(@Auth() auth: AuthContext, @ClientInfo() client: { ip?: string; userAgent?: string }, @Body() body: unknown) {
    const { entry } = parse(entrySchema, body);
    const db = this.tenantDb.db;
    const log = (result: "success" | "denied", reason?: string) =>
      db.loginLog.create({
        data: { tenantId: auth.tenantId, accountId: auth.accountId, username: auth.authz.username, entry, result, reason: reason ?? null, ip: client.ip ?? null, userAgent: client.userAgent ?? null },
      });
    const denied = await this.qualify(auth, entry);
    if (denied) {
      await log("denied", denied);
      throw new ForbiddenException(denied);
    }
    if (auth.authz.status === "pending") {
      await db.account.update({ where: { id: auth.accountId }, data: { status: "active" } });
      await this.authz.bump(auth.tenantId);
    }
    await log("success");
    if (auth.sid) {
      await this.sessions.touch(auth.tenantId, { sid: auth.sid, accountId: auth.accountId, username: auth.authz.username, entry, ip: client.ip, userAgent: client.userAgent }, true);
    }
    const fresh = (await this.authz.load(auth.tenantId, auth.accountId)) ?? auth.authz;
    return { account: { id: auth.accountId, username: auth.authz.username }, entry, permissions: fresh.perms, menus: await this.tree({ ...auth, authz: fresh }, entry) };
  }

  private async tree(auth: AuthContext, entry: "admin" | "portal") {
    const graph = await this.authz.graph();
    if (entry === "portal") return graph.tree("portal", () => true);
    const ticked = new Set(auth.authz.roles.flatMap((r) => r.menuIds));
    return graph.tree("admin", (m) => ticked.has(m.id));
  }

  /** 入口资格：返回 null 表示通过，否则是拒绝原因。 */
  private async qualify(auth: AuthContext, entry: "admin" | "portal"): Promise<string | null> {
    const personId = auth.authz.personId;
    const person = personId ? await this.tenantDb.db.person.findUnique({ where: { id: personId } }) : null;
    if (entry === "admin") {
      const staff = personId ? await this.tenantDb.db.staffProfile.findFirst({ where: { personId } }) : null;
      // 管理入口要求"在职"的教职员工档案（旧数据只有类型、没有档案的按类型认）；离职/停薪留职立即拒绝
      if (staff && staff.status !== "active" && !auth.authz.isBuiltinAdmin) return "Employment has ended or is suspended";
      if (!auth.authz.isBuiltinAdmin && !staff && person?.type !== "staff") return "Only staff can use the admin console";
      if ((await this.tree(auth, "admin")).length === 0) return "No menus are assigned to this account";
      return null;
    }
    // 学生门户按学籍状态的细化在 B6（教学）补充
    if (person?.type !== "student") return "Only students can use the student portal";
    return null;
  }

  private async assertQualified(auth: AuthContext, entry: "admin" | "portal"): Promise<void> {
    const denied = await this.qualify(auth, entry);
    if (denied) throw new ForbiddenException(denied);
  }
}
