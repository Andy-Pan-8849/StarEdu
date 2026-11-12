// "我"：登录登记（入口资格检查 + 登录日志 + 在线状态）、我的信息、我的菜单树。
// 这三个接口对任何已登录的本租户账号开放（AnyAuthenticated），数据只涉及账号自己。
import { Body, Controller, ForbiddenException, Get, NotFoundException, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { AnyAuthenticated } from "../auth/decorators";
import { SessionStore } from "../auth/session-store";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, ClientInfo, parse } from "../common/http";
import { AuthzService } from "../rbac/authz.service";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";

const entrySchema = z.object({ entry: z.enum(["admin", "portal"]) });

@Controller("api")
export class MeController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly authz: AuthzService,
    private readonly sessions: SessionStore,
  ) {}

  @Get("me")
  @AnyAuthenticated()
  async me(@Auth() auth: AuthContext) {
    const account = await this.tenantDb.db.account.findUnique({ where: { id: auth.accountId } });
    if (!account) throw new NotFoundException("Account not found in this tenant");
    return {
      id: account.id,
      tenantId: account.tenantId,
      username: account.username,
      status: account.status,
      roles: auth.authz.roles.map((r) => ({ id: r.id, code: r.code, kind: r.kind })),
      permissions: auth.authz.perms,
    };
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
      if (!auth.authz.isBuiltinAdmin && person?.type !== "staff") return "Only staff can use the admin console";
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
