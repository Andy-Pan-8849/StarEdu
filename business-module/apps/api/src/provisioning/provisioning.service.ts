// 开通租户：建租户记录 → Keycloak 域 → 总部校区与部门根 → 角色 → 功能授权 → 内置管理员 → 发邀请。
// 每一步都可重复运行（幂等）：中途失败后再运行同一个命令，从没做完的地方继续，不会重复建。
// 用库所有者账号连库（绕过行级安全）——这是平台操作，不属于任何租户的请求。
import { checkTenantCode, realmName } from "@staredu/shared";
import { PrismaClient, TenantType } from "../generated/prisma";
import { KeycloakAdmin } from "../keycloak/keycloak-admin";
import { createRealm, smtpFromEnv, tenantOrigin } from "../keycloak/realm-provisioner";

export interface ProvisionInput {
  code: string;
  name: string;
  type?: TenantType;
  timezone?: string;
  adminEmail: string;
  /** 仅测试：让该租户域允许密码直连授权 */
  allowDirectGrant?: boolean;
}

export interface ProvisionResult {
  tenantId: string;
  code: string;
  /** 本次是否新建（false = 之前已开通完成，什么都没做） */
  created: boolean;
  steps: string[];
  inviteSent: boolean;
  inviteError?: string;
}

export const BUILTIN_ADMIN_USERNAME = "admin";
export const ROLE_TENANT_ADMIN = "tenant-admin";
export const ROLE_STUDENT = "student";

export class ProvisioningService {
  constructor(
    private readonly owner: PrismaClient,
    private readonly keycloak: KeycloakAdmin,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    const problem = checkTenantCode(input.code);
    if (problem) throw new Error(`invalid tenant code "${input.code}": ${problem}`);

    const steps: string[] = [];
    let tenant = await this.owner.tenant.findUnique({ where: { code: input.code } });
    const created = !tenant;
    if (tenant?.status === "active" || tenant?.status === "notified" || tenant?.status === "suspended") {
      return { tenantId: tenant.id, code: tenant.code, created: false, steps: ["already provisioned"], inviteSent: false };
    }
    if (!tenant) {
      tenant = await this.owner.tenant.create({
        data: {
          code: input.code,
          name: input.name,
          type: input.type ?? "direct",
          timezone: input.timezone ?? "UTC",
          contactEmail: input.adminEmail,
        },
      });
      steps.push("tenant record");
    }
    const tenantId = tenant.id;
    const realm = realmName("tenant", tenant.code);

    // 1. Keycloak 域
    const realmResult = await createRealm(this.keycloak, {
      kind: "tenant",
      code: tenant.code,
      name: tenant.name,
      tenantId,
      webOrigin: tenantOrigin(tenant.code, this.env),
      smtp: smtpFromEnv(this.env),
      allowDirectGrant: input.allowDirectGrant,
    });
    if (realmResult === "created") steps.push("keycloak realm");
    await this.mark(tenantId, "realm");

    // 2. 总部校区 = 部门树根节点 + 校区记录（总部也是一个校区，不能关闭）
    if (!(await this.owner.campus.findFirst({ where: { tenantId, type: "hq" } }))) {
      const dept = await this.owner.dept.create({ data: { tenantId, name: tenant.name } });
      await this.owner.campus.create({
        data: { tenantId, deptId: dept.id, code: "HQ", name: tenant.name, type: "hq", timezone: tenant.timezone },
      });
      steps.push("headquarters campus");
    }
    await this.mark(tenantId, "structure");

    // 3. 角色：内置两个 + 复制平台角色模板
    const builtin: Array<{ code: string; name: string; kind: "tenant_admin" | "student" }> = [
      { code: ROLE_TENANT_ADMIN, name: "Tenant administrator", kind: "tenant_admin" },
      { code: ROLE_STUDENT, name: "Student", kind: "student" },
    ];
    for (const r of builtin) {
      const exists = await this.owner.role.findFirst({ where: { tenantId, code: r.code } });
      if (!exists) {
        await this.owner.role.create({ data: { tenantId, code: r.code, name: r.name, kind: r.kind } });
        steps.push(`role ${r.code}`);
      }
    }
    const templates = await this.owner.role.findMany({ where: { tenantId: null, isTemplate: true, deletedAt: null } });
    for (const t of templates) {
      const exists = await this.owner.role.findFirst({ where: { tenantId, code: t.code } });
      if (!exists) {
        await this.owner.role.create({
          data: { tenantId, code: t.code, name: t.name, kind: "custom", templateId: t.id, sort: t.sort },
        });
        steps.push(`role template ${t.code}`);
      }
    }
    await this.mark(tenantId, "roles");

    // 4. 功能授权：开通时默认授权全部平台提供的菜单和按钮（入口为"平台"的菜单不授权给租户）
    const platformMenus = await this.owner.menu.findMany({
      where: { tenantId: null, deletedAt: null, status: true },
      select: { id: true },
    });
    const granted = new Set(
      (await this.owner.tenantMenuGrant.findMany({ where: { tenantId }, select: { menuId: true } })).map((g) => g.menuId),
    );
    const toGrant = platformMenus.filter((m) => !granted.has(m.id));
    if (toGrant.length > 0) {
      await this.owner.tenantMenuGrant.createMany({ data: toGrant.map((m) => ({ tenantId, menuId: m.id })) });
      steps.push(`menu grants (${toGrant.length})`);
    }
    await this.mark(tenantId, "menus");

    // 5. 内置租户管理员：不关联人员，不能删除；先写业务库（待激活），再建 Keycloak 用户
    let account = await this.owner.account.findFirst({ where: { tenantId, isBuiltinAdmin: true } });
    if (!account) {
      account = await this.owner.account.create({
        data: {
          tenantId,
          username: BUILTIN_ADMIN_USERNAME,
          email: input.adminEmail,
          isBuiltinAdmin: true,
          status: "pending",
        },
      });
      const adminRole = await this.owner.role.findFirstOrThrow({ where: { tenantId, code: ROLE_TENANT_ADMIN } });
      await this.owner.accountRole.create({ data: { tenantId, accountId: account.id, roleId: adminRole.id } });
      steps.push("built-in admin account");
    }
    let inviteSent = false;
    let inviteError: string | undefined;
    if (!account.keycloakUserId) {
      const existing = await this.keycloak.findUser(realm, account.username);
      const userId =
        existing?.id ??
        (await this.keycloak.createUser(realm, {
          username: account.username,
          email: input.adminEmail,
          accountId: account.id,
        }));
      account = await this.owner.account.update({ where: { id: account.id }, data: { keycloakUserId: userId } });
      steps.push("keycloak admin user");
      // 邀请邮件失败（如 SMTP 暂不可用）不让开通失败；"重发邀请"在平台入口里补（B3）
      try {
        await this.keycloak.sendInvite(realm, userId, "admin", `${tenantOrigin(tenant.code, this.env)}/admin`);
        inviteSent = true;
        steps.push("invite email");
      } catch (err) {
        inviteError = err instanceof Error ? err.message : String(err);
      }
    }
    await this.mark(tenantId, "admin");

    // 6. 完成
    await this.owner.tenant.update({ where: { id: tenantId }, data: { status: "active", provisionStep: "done" } });
    steps.push("active");
    return { tenantId, code: tenant.code, created, steps, inviteSent, inviteError };
  }

  private async mark(tenantId: string, step: string): Promise<void> {
    await this.owner.tenant.update({ where: { id: tenantId }, data: { provisionStep: step } });
  }
}
