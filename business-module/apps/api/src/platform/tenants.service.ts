// 租户管理（平台入口）：开通、改基本信息、状态机、功能授权、管理员。
// 租户不提供删除，只能停用；租户代码开通后不可改（数据库触发器保证）。
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { realmName } from "@staredu/shared";
import type { TenantStatus, TenantType } from "../generated/prisma";
import { KeycloakService } from "../keycloak/keycloak.service";
import { tenantOrigin } from "../keycloak/realm-provisioner";
import { MailService } from "../mail/mail.service";
import { ProvisioningService } from "../provisioning/provisioning.service";
import { grantablePlatformMenuIds } from "../catalog/menu-sync";
import { RedisService } from "../redis/redis.service";
import { PlatformAuditService } from "./platform-audit.service";
import { PlatformAuthzService } from "./platform-authz.service";
import { PlatformPrismaService } from "./platform-prisma.service";

export type StatusAction = "notify" | "suspend" | "restore" | "cancel-notice";

/** 状态机：正常 → 已通知待停用 → 已停用；任何时候都可以直接停用；已通知可以撤销；已停用可以恢复。 */
const TRANSITIONS: Record<StatusAction, { from: TenantStatus[]; to: TenantStatus }> = {
  notify: { from: ["active"], to: "notified" },
  suspend: { from: ["active", "notified"], to: "suspended" },
  "cancel-notice": { from: ["notified"], to: "active" },
  restore: { from: ["suspended"], to: "active" },
};

@Injectable()
export class TenantsService {
  constructor(
    private readonly db: PlatformPrismaService,
    private readonly keycloak: KeycloakService,
    private readonly mail: MailService,
    private readonly audit: PlatformAuditService,
    private readonly authz: PlatformAuthzService,
    private readonly redis: RedisService,
  ) {}

  private async tenant(id: string) {
    const t = await this.db.tenant.findUnique({ where: { id } });
    if (!t) throw new NotFoundException();
    return t;
  }

  private view(t: Awaited<ReturnType<TenantsService["tenant"]>>, admin?: { email: string | null; status: string } | null) {
    return {
      id: t.id,
      code: t.code,
      name: t.name,
      shortName: t.shortName,
      type: t.type,
      status: t.status,
      timezone: t.timezone,
      contactName: t.contactName,
      contactEmail: t.contactEmail,
      contactPhone: t.contactPhone,
      remark: t.remark,
      plannedSuspendAt: t.plannedSuspendAt,
      noticeText: t.noticeText,
      notifiedAt: t.notifiedAt,
      suspendedAt: t.suspendedAt,
      createdAt: t.createdAt,
      loginUrl: tenantOrigin(t.code),
      admin: admin ?? null,
    };
  }

  async list() {
    const tenants = await this.db.tenant.findMany({ orderBy: { createdAt: "asc" } });
    const admins = await this.db.account.findMany({ where: { isBuiltinAdmin: true, deletedAt: null }, select: { tenantId: true, email: true, status: true } });
    return tenants.map((t) => this.view(t, admins.find((a) => a.tenantId === t.id)));
  }

  async get(id: string) {
    const t = await this.tenant(id);
    return this.view(t, await this.db.account.findFirst({ where: { tenantId: id, isBuiltinAdmin: true }, select: { email: true, status: true } }));
  }

  async create(actorId: string, input: { code: string; name: string; type?: TenantType; timezone?: string; adminEmail: string; hqCampusName?: string }) {
    if (await this.db.tenant.findUnique({ where: { code: input.code } })) throw new ConflictException("Tenant code already exists");
    let result;
    try {
      result = await new ProvisioningService(this.db, await this.keycloak.client()).provision(input);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : String(err));
    }
    await this.audit.record(actorId, "tenant.create", "tenant", result.tenantId, { code: input.code, steps: result.steps });
    return { ...result, tenant: await this.get(result.tenantId) };
  }

  async update(actorId: string, id: string, patch: Record<string, unknown>) {
    await this.tenant(id);
    await this.db.tenant.update({ where: { id }, data: patch });
    await this.audit.record(actorId, "tenant.update", "tenant", id, patch);
    return this.get(id);
  }

  async changeStatus(actorId: string, id: string, action: StatusAction, input: { plannedSuspendAt?: Date | null; noticeText?: string | null }) {
    const t = await this.tenant(id);
    const rule = TRANSITIONS[action];
    if (!rule.from.includes(t.status)) throw new ConflictException(`Cannot ${action} a tenant that is ${t.status}`);
    const data: Record<string, unknown> = { status: rule.to };
    if (action === "notify") {
      if (!input.noticeText) throw new BadRequestException("A notice text is required");
      Object.assign(data, { plannedSuspendAt: input.plannedSuspendAt ?? null, noticeText: input.noticeText, notifiedAt: new Date() });
    }
    if (action === "suspend") Object.assign(data, { suspendedAt: new Date() });
    if (action === "restore" || action === "cancel-notice") Object.assign(data, { suspendedAt: null, plannedSuspendAt: null, noticeText: null, notifiedAt: null });
    await this.db.tenant.update({ where: { id }, data });
    let mailed: boolean | null = null;
    if (action === "notify") {
      const admin = await this.db.account.findFirst({ where: { tenantId: id, isBuiltinAdmin: true } });
      const to = admin?.email ?? t.contactEmail;
      if (to) {
        try {
          await this.mail.send(to, `[StarEdu] Planned suspension of ${t.name}`, `${input.noticeText}\n\nPlanned suspension: ${input.plannedSuspendAt?.toISOString() ?? "to be announced"}`);
          mailed = true;
        } catch {
          mailed = false; // 邮件失败不让状态变更失败；平台管理员能在结果里看到
        }
      }
    }
    await this.audit.record(actorId, `tenant.${action}`, "tenant", id, { from: t.status, to: rule.to, mailed });
    return { ...(await this.get(id)), mailed };
  }

  // ---- 功能授权 ----
  /** 可授权的菜单树（管理后台和学生门户下的；平台入口的不出现）和该租户已授权的 id。 */
  async grants(id: string) {
    await this.tenant(id);
    const graph = await this.authz.graph();
    const granted = (await this.db.tenantMenuGrant.findMany({ where: { tenantId: id } })).map((g) => g.menuId);
    return { tree: { admin: graph.tree("admin", () => true, { forEditor: true }), portal: graph.tree("portal", () => true, { forEditor: true }) }, granted };
  }

  async setGrants(actorId: string, id: string, menuIds: string[]) {
    await this.tenant(id);
    const grantable = new Set(await grantablePlatformMenuIds(this.db));
    const wanted = [...new Set(menuIds)];
    if (!wanted.every((m) => grantable.has(m))) throw new BadRequestException("Unknown or non-grantable menu");
    const before = new Set((await this.db.tenantMenuGrant.findMany({ where: { tenantId: id } })).map((g) => g.menuId));
    await this.db.$transaction([
      this.db.tenantMenuGrant.deleteMany({ where: { tenantId: id } }),
      this.db.tenantMenuGrant.createMany({ data: wanted.map((menuId) => ({ tenantId: id, menuId })) }),
    ]);
    await this.redis.client.incr(`perm:v:${id}`); // 该租户所有人的权限缓存立即作废
    await this.audit.record(actorId, "tenant.grants", "tenant", id, {
      added: wanted.filter((m) => !before.has(m)).length,
      removed: [...before].filter((m) => !wanted.includes(m)).length,
    });
    return { granted: wanted };
  }

  // ---- 管理员页签 ----
  private async adminAccount(id: string) {
    const t = await this.tenant(id);
    const account = await this.db.account.findFirst({ where: { tenantId: id, isBuiltinAdmin: true } });
    if (!account) throw new NotFoundException("The tenant has no built-in administrator yet");
    return { t, account, realm: realmName("tenant", t.code) };
  }

  async admin(id: string) {
    const { account, realm } = await this.adminAccount(id);
    const kc = account.keycloakUserId ? await (await this.keycloak.client()).getUser(realm, account.keycloakUserId) : null;
    return { id: account.id, username: account.username, email: account.email, status: account.status, keycloakEnabled: kc?.enabled ?? null };
  }

  /** 重发邀请 / 重置密码：都是给管理员邮箱发"设置密码"链接（有效期取域设置）。 */
  async sendPasswordLink(actorId: string, id: string, kind: "invite" | "reset") {
    const { t, account, realm } = await this.adminAccount(id);
    if (!account.keycloakUserId || !account.email) throw new ConflictException("The administrator has no identity-service user or e-mail yet");
    await (await this.keycloak.client()).sendInvite(realm, account.keycloakUserId, "admin", `${tenantOrigin(t.code)}/admin`);
    await this.audit.record(actorId, `tenant.admin.${kind}`, "tenant", id, { email: account.email });
    return { sent: true };
  }

  async unlock(actorId: string, id: string) {
    const { account, realm } = await this.adminAccount(id);
    if (!account.keycloakUserId) throw new ConflictException("The administrator has no identity-service user yet");
    await (await this.keycloak.client()).unlockUser(realm, account.keycloakUserId);
    await this.audit.record(actorId, "tenant.admin.unlock", "tenant", id);
    return { unlocked: true };
  }

  async changeAdminEmail(actorId: string, id: string, email: string) {
    const { account, realm } = await this.adminAccount(id);
    await this.db.account.update({ where: { id: account.id }, data: { email } });
    if (account.keycloakUserId) await (await this.keycloak.client()).updateUser(realm, account.keycloakUserId, { email });
    await this.audit.record(actorId, "tenant.admin.email", "tenant", id, { email });
    return this.admin(id);
  }
}
