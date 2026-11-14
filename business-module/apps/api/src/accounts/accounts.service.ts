// 账号：业务库是"你是谁"的主记录，Keycloak 负责认证。
//   创建顺序：业务库写一条"待激活"账号 → 在该租户的 Keycloak 域建用户 → 回写 Keycloak 用户 id → 发邀请邮件。
//   中途失败账号留在"待激活、没有 Keycloak 用户"，对账能发现并补建。
//   改邮箱、停用/启用从这里推送给 Keycloak；定时对账发现两边不一致（以业务库为准）。
import { QuotaService } from "../quota/quota.service";
import { randomInt } from "node:crypto";
import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { realmName } from "@staredu/shared";
import { AuditService } from "../audit/audit.service";
import { KeycloakService } from "../keycloak/keycloak.service";
import { tenantOrigin } from "../keycloak/realm-provisioner";
import { AuthzService, type Authz } from "../rbac/authz.service";
import { requireTenant } from "../tenancy/request-scope";
import { assertVisible } from "../tenancy/owned";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";

export interface CreateAccountInput {
  username: string;
  email?: string;
  personId?: string;
  roleIds?: string[];
  /** student：自动分配内置"学生"角色 */
  kind?: "staff" | "student";
  sendInvite?: boolean;
}

export type Discrepancy =
  | { type: "missing_in_keycloak"; accountId: string; username: string }
  | { type: "unlinked_in_keycloak"; keycloakUserId: string; username: string }
  | { type: "enabled_mismatch"; accountId: string; username: string; business: boolean; keycloak: boolean }
  | { type: "email_mismatch"; accountId: string; username: string; business: string | null; keycloak: string | null };

export interface ReconcileReport {
  checked: number;
  discrepancies: Discrepancy[];
  fixed: number;
}

const enabledFor = (status: string): boolean => status === "active" || status === "pending";

@Injectable()
export class AccountsService {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly keycloak: KeycloakService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly quota: QuotaService,
  ) {}

  async create(actor: Authz, input: CreateAccountInput) {
    const tenant = requireTenant("create account");
    const db = this.tenantDb.db;
    if (input.personId) await assertVisible(db.person, [input.personId], "person");

    const roleIds = [...new Set(input.roleIds ?? [])];
    if (roleIds.length) {
      await assertVisible(db.role, roleIds, "role");
      await this.assertAssignable(actor, roleIds);
    }
    if (input.kind === "student") {
      const studentRole = await db.role.findFirst({ where: { kind: "student" } });
      if (!studentRole) throw new BadRequestException("This tenant has no student role");
      roleIds.push(studentRole.id);
    }

    await this.quota.assertCanAddAccounts();
    let account;
    try {
      account = await this.tenantDb.transaction(async (tx) => {
        const row = await tx.account.create({
          data: { tenantId: tenant.tenantId, username: input.username, email: input.email ?? null, personId: input.personId ?? null, status: "pending", createdBy: actor.accountId },
        });
        if (roleIds.length) await tx.accountRole.createMany({ data: roleIds.map((roleId) => ({ tenantId: tenant.tenantId, accountId: row.id, roleId })) });
        return row;
      });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw new ConflictException("Username, email or person already has an account");
      throw err;
    }
    await this.authz.bump(tenant.tenantId);

    const realm = realmName("tenant", tenant.code);
    let inviteSent = false;
    try {
      const admin = await this.keycloak.client();
      const userId = await admin.createUser(realm, { username: account.username, email: account.email ?? undefined, accountId: account.id });
      account = await db.account.update({ where: { id: account.id }, data: { keycloakUserId: userId } });
      if (input.sendInvite !== false && account.email) {
        try {
          await admin.sendInvite(realm, userId, input.kind === "student" ? "portal" : "admin", `${tenantOrigin(tenant.code)}${input.kind === "student" ? "/" : "/admin"}`);
          inviteSent = true;
        } catch {
          /* 邀请失败不让创建失败；"重发邀请"后续里程碑补 */
        }
      }
    } catch (err) {
      await this.audit.record(actor.accountId, "account.create", "account", account.id, { username: account.username, keycloak: "failed" });
      throw new BadGatewayException(`Account ${account.id} was saved but could not be created in the identity service (${err instanceof Error ? err.message : err}); run reconcile to retry`);
    }
    await this.audit.record(actor.accountId, "account.create", "account", account.id, { username: account.username, roleIds, kind: input.kind ?? "staff" });
    return { id: account.id, username: account.username, status: account.status, keycloakUserId: account.keycloakUserId, inviteSent };
  }

  async setStatus(actor: Authz, accountId: string, status: "active" | "disabled") {
    const tenant = requireTenant("change account status");
    const db = this.tenantDb.db;
    const account = await db.account.findUnique({ where: { id: accountId } });
    if (!account) throw new NotFoundException();
    if (account.isBuiltinAdmin) throw new ForbiddenException("The built-in administrator cannot be disabled");
    if (account.id === actor.accountId && status === "disabled") throw new ForbiddenException("You cannot disable your own account");
    await db.account.update({ where: { id: accountId }, data: { status, updatedBy: actor.accountId } });
    await this.authz.bump(tenant.tenantId); // 下一个请求起生效
    let synced = true;
    if (account.keycloakUserId) {
      try {
        await (await this.keycloak.client()).updateUser(realmName("tenant", tenant.code), account.keycloakUserId, { enabled: enabledFor(status) });
      } catch {
        synced = false; // 以业务库为准，对账会补推
      }
    }
    await this.audit.record(actor.accountId, "account.status", "account", accountId, { from: account.status, to: status, synced });
    return { id: accountId, status, synced };
  }

  async updateEmail(actor: Authz, accountId: string, email: string | null) {
    const tenant = requireTenant("change account email");
    const db = this.tenantDb.db;
    const account = await db.account.findUnique({ where: { id: accountId } });
    if (!account) throw new NotFoundException();
    try {
      await db.account.update({ where: { id: accountId }, data: { email, updatedBy: actor.accountId } });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw new ConflictException("Email already in use");
      throw err;
    }
    let synced = true;
    if (account.keycloakUserId) {
      try {
        await (await this.keycloak.client()).updateUser(realmName("tenant", tenant.code), account.keycloakUserId, { email });
      } catch {
        synced = false;
      }
    }
    await this.audit.record(actor.accountId, "account.email", "account", accountId, { synced });
    return { id: accountId, email, synced };
  }

  /** 把"能分配给别人的角色"限制为：自定义角色，且其权限不超过操作者自己的权限（防提权）。 */
  private async assertAssignable(actor: Authz, roleIds: string[]): Promise<void> {
    const views = await this.authz.rolesView(roleIds);
    const mine = new Set(actor.perms);
    for (const role of views) {
      if (role.kind !== "custom") throw new ForbiddenException("Built-in roles cannot be assigned manually");
      if (!role.perms.every((p) => mine.has(p))) throw new ForbiddenException("You cannot grant permissions you do not have");
    }
  }

  async assignRoles(actor: Authz, accountId: string, roleIds: string[]) {
    const tenant = requireTenant("assign roles");
    const db = this.tenantDb.db;
    const account = await db.account.findUnique({ where: { id: accountId } });
    if (!account) throw new NotFoundException();
    if (account.isBuiltinAdmin) throw new ForbiddenException("The built-in administrator's roles cannot be changed");
    const wanted = [...new Set(roleIds)];
    await assertVisible(db.role, wanted, "role");
    await this.assertAssignable(actor, wanted);

    const current = await db.accountRole.findMany({ where: { accountId } });
    const currentRoles = current.length ? await db.role.findMany({ where: { id: { in: current.map((c) => c.roleId) } } }) : [];
    const keep = currentRoles.filter((r) => r.kind !== "custom").map((r) => r.id); // 内置角色（学生）不受影响
    const before = currentRoles.filter((r) => r.kind === "custom").map((r) => r.id);
    await this.tenantDb.transaction(async (tx) => {
      await tx.accountRole.deleteMany({ where: { accountId, roleId: { notIn: keep } } });
      if (wanted.length) await tx.accountRole.createMany({ data: wanted.map((roleId) => ({ tenantId: tenant.tenantId, accountId, roleId })) });
    });
    await this.authz.bump(tenant.tenantId);
    await this.audit.record(actor.accountId, "account.roles", "account", accountId, { before: before.sort(), after: wanted.sort() });
    return { id: accountId, roleIds: wanted };
  }

  private async keycloakTarget(accountId: string) {
    const tenant = requireTenant("manage account credentials");
    const account = await this.tenantDb.db.account.findUnique({ where: { id: accountId } });
    if (!account) throw new NotFoundException();
    // 内置租户管理员只有平台管理员能重置
    if (account.isBuiltinAdmin) throw new ForbiddenException("Only a platform administrator can reset the built-in administrator");
    if (!account.keycloakUserId) throw new BadRequestException("The account has no identity-service user yet; run reconcile first");
    return { tenant, account, realm: realmName("tenant", tenant.code) };
  }

  /** 重发邀请 / 发重设密码链接（都是"设置密码"邮件，学生走门户、教职员工走后台）。 */
  async sendLink(actor: Authz, accountId: string, kind: "invite" | "reset") {
    const { tenant, account, realm } = await this.keycloakTarget(accountId);
    if (!account.email) throw new BadRequestException("The account has no e-mail address; use a temporary password instead");
    const person = account.personId ? await this.tenantDb.db.person.findUnique({ where: { id: account.personId } }) : null;
    const portal = person?.type === "student";
    await (await this.keycloak.client()).sendInvite(realm, account.keycloakUserId as string, portal ? "portal" : "admin", `${tenantOrigin(tenant.code)}${portal ? "/" : "/admin"}`);
    await this.audit.record(actor.accountId, `account.${kind}`, "account", accountId, { email: account.email });
    return { sent: true };
  }

  /** 临时密码：随机 12 位（含大小写、数字、特殊字符），只在这次响应里显示；用户登录后被强制改密。密码不写日志。 */
  async tempPassword(actor: Authz, accountId: string) {
    const { account, realm } = await this.keycloakTarget(accountId);
    let password = "";
    do password = generateTempPassword();
    while (password.toLowerCase().includes(account.username.toLowerCase()) || (account.email && password.toLowerCase().includes(account.email.toLowerCase())));
    await (await this.keycloak.client()).resetPassword(realm, account.keycloakUserId as string, password, true);
    await this.audit.record(actor.accountId, "account.tempPassword", "account", accountId);
    return { password, mustChange: true };
  }

  async unlock(actor: Authz, accountId: string) {
    const { account, realm } = await this.keycloakTarget(accountId);
    await (await this.keycloak.client()).unlockUser(realm, account.keycloakUserId as string);
    await this.audit.record(actor.accountId, "account.unlock", "account", accountId);
    return { unlocked: true };
  }

  /** 对账：业务库与 Keycloak 域逐个账号比对。fix 为真时按业务库为准补推（不会删除任何一边的数据）。 */
  async reconcile(actor: { accountId: string | null }, fix: boolean): Promise<ReconcileReport> {
    const tenant = requireTenant("reconcile accounts");
    const realm = realmName("tenant", tenant.code);
    const admin = await this.keycloak.client();
    const accounts = await this.tenantDb.db.account.findMany({ where: { isService: false } });
    const users = await admin.listUsers(realm);
    const byId = new Map(users.map((u) => [u.id, u]));
    const byAccountAttr = new Map(users.flatMap((u) => (u.attributes?.account_id?.[0] ? [[u.attributes.account_id[0], u] as const] : [])));
    const discrepancies: Discrepancy[] = [];
    let fixed = 0;
    const seen = new Set<string>();

    for (const a of accounts) {
      const user = (a.keycloakUserId ? byId.get(a.keycloakUserId) : undefined) ?? byAccountAttr.get(a.id);
      if (!user) {
        discrepancies.push({ type: "missing_in_keycloak", accountId: a.id, username: a.username });
        if (fix) {
          const existing = await admin.findUser(realm, a.username);
          const id = existing?.id ?? (await admin.createUser(realm, { username: a.username, email: a.email ?? undefined, accountId: a.id }));
          await this.tenantDb.db.account.update({ where: { id: a.id }, data: { keycloakUserId: id } });
          if (!enabledFor(a.status)) await admin.updateUser(realm, id, { enabled: false });
          fixed += 1;
        }
        continue;
      }
      seen.add(user.id);
      if (a.keycloakUserId !== user.id && fix) {
        await this.tenantDb.db.account.update({ where: { id: a.id }, data: { keycloakUserId: user.id } });
        fixed += 1;
      }
      if ((user.enabled ?? true) !== enabledFor(a.status)) {
        discrepancies.push({ type: "enabled_mismatch", accountId: a.id, username: a.username, business: enabledFor(a.status), keycloak: user.enabled ?? true });
        if (fix) {
          await admin.updateUser(realm, user.id, { enabled: enabledFor(a.status) });
          fixed += 1;
        }
      }
      if ((user.email ?? null) !== (a.email ?? null)) {
        discrepancies.push({ type: "email_mismatch", accountId: a.id, username: a.username, business: a.email, keycloak: user.email ?? null });
        if (fix) {
          await admin.updateUser(realm, user.id, { email: a.email });
          fixed += 1;
        }
      }
    }
    for (const u of users) {
      if (!seen.has(u.id)) discrepancies.push({ type: "unlinked_in_keycloak", keycloakUserId: u.id, username: u.username });
    }
    await this.audit.record(actor.accountId, "account.reconcile", "tenant", tenant.tenantId, { discrepancies: discrepancies.length, fixed, fix });
    return { checked: accounts.length, discrepancies, fixed };
  }
}

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnpqrstuvwxyz";
const DIGITS = "23456789";
const SPECIAL = "!@#$%^&*-_=+";

/** 12 位随机密码：每类字符至少一个（去掉了容易看混的 0/O、1/l/I），再整体洗牌。 */
export function generateTempPassword(length = 12): string {
  const pick = (set: string) => set[randomInt(set.length)];
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SPECIAL)];
  const all = UPPER + LOWER + DIGITS + SPECIAL;
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
