// 集成测试共用：连真实 Postgres 和 Keycloak，建临时租户，用完清理。
import { randomBytes } from "node:crypto";
import { realmName } from "@staredu/shared";
import { PrismaClient } from "../../src/generated/prisma";
import { KeycloakAdmin } from "../../src/keycloak/keycloak-admin";
import { ProvisioningService, type ProvisionResult } from "../../src/provisioning/provisioning.service";

export const PASSWORD = "Str0ng!Passw0rd";

export function ownerClient(): PrismaClient {
  return new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
}

/** 低权限账号 biz_app；connection_limit=1 让所有查询共用一条连接，才能验证会话变量不会漏。 */
export function appClient(): PrismaClient {
  const url = new URL(process.env.DATABASE_URL as string);
  url.searchParams.set("connection_limit", "1");
  return new PrismaClient({ datasourceUrl: url.toString() });
}

export function randomCode(prefix = "tst"): string {
  return `${prefix}${randomBytes(3).toString("hex")}`;
}

export interface TestTenant extends ProvisionResult {
  name: string;
  adminEmail: string;
}

export async function connectKeycloak(): Promise<KeycloakAdmin> {
  try {
    return await KeycloakAdmin.connect();
  } catch (err) {
    throw new Error(`Keycloak is not reachable (run "make up" first): ${err instanceof Error ? err.message : err}`);
  }
}

export async function provisionTestTenant(
  owner: PrismaClient,
  keycloak: KeycloakAdmin,
  code = randomCode(),
): Promise<TestTenant> {
  const adminEmail = `admin@${code}.example.test`;
  const name = `Test ${code}`;
  const result = await new ProvisioningService(owner, keycloak).provision({
    code,
    name,
    adminEmail,
    allowDirectGrant: true,
  });
  return { ...result, name, adminEmail };
}

/** 在业务库和该租户的 Keycloak 域里各建一个账号，返回换令牌的方法。 */
export async function createUser(
  owner: PrismaClient,
  keycloak: KeycloakAdmin,
  tenant: { tenantId: string; code: string },
  username: string,
): Promise<{ accountId: string; token: () => Promise<string> }> {
  const account = await owner.account.create({
    data: { tenantId: tenant.tenantId, username, email: `${username}@${tenant.code}.example.test`, status: "active" },
  });
  const realm = realmName("tenant", tenant.code);
  const userId = await keycloak.createUser(realm, {
    username,
    email: account.email ?? undefined,
    accountId: account.id,
    password: PASSWORD,
  });
  await owner.account.update({ where: { id: account.id }, data: { keycloakUserId: userId } });
  return {
    accountId: account.id,
    token: async () => {
      const res = await fetch(`${keycloak.url}/realms/${realm}/protocol/openid-connect/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "password", client_id: "portal", username, password: PASSWORD }),
      });
      if (!res.ok) throw new Error(`login failed for ${username}: ${res.status} ${await res.text()}`);
      return ((await res.json()) as { access_token: string }).access_token;
    },
  };
}

/** 给账号分配角色（按角色编码，如 tenant-admin / hr-manager / student），库所有者账号直接写。 */
export async function giveRole(owner: PrismaClient, tenantId: string, accountId: string, roleCode: string): Promise<string> {
  const role = await owner.role.findFirstOrThrow({ where: { tenantId, code: roleCode } });
  await owner.accountRole.upsert({
    where: { accountId_roleId: { accountId, roleId: role.id } },
    create: { tenantId, accountId, roleId: role.id },
    update: {},
  });
  return role.id;
}

/** 删除一个测试租户的全部数据和 Keycloak 域（用库所有者账号，按外键顺序）。 */
export async function removeTestTenant(owner: PrismaClient, keycloak: KeycloakAdmin, code: string): Promise<void> {
  const tenant = await owner.tenant.findUnique({ where: { code } });
  if (tenant) {
    const id = tenant.id;
    await owner.$transaction([
      owner.$executeRaw`DELETE FROM biz.login_log WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.audit_log WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.outbox_event WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.transcript_issue WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.grade_change WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.final_grade WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.manual_grade WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.grading_scale_item WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.submission_score WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.submission_file WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.submission_version WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.submission WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.assignment_extension WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.rubric_item WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.assignment WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.assignment_group WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.section_material WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.enrollment WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.section_instructor WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.section WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.student_major WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.major_course WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.course_prerequisite WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.course WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.major WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.term WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.emergency_contact WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.staff_profile WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.student_profile WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.operation_log WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.dict_item WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.dict_type WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.sys_param WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.person_dept WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.data_scope_set_node WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.role_data_scope WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.role_menu WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.account_role WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.account WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.person WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.campus WHERE tenant_id = ${id}::uuid`,
      // 部门树：先删子再删父，用祖先链长度倒序
      owner.$executeRaw`DELETE FROM biz.dept WHERE tenant_id = ${id}::uuid AND parent_id IS NOT NULL`,
      owner.$executeRaw`DELETE FROM biz.dept WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.post WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.entry_menu WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.tenant_menu_grant WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.menu WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.data_scope_set WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.role WHERE tenant_id = ${id}::uuid`,
      owner.$executeRaw`DELETE FROM biz.tenant WHERE id = ${id}::uuid`,
    ]);
  }
  await keycloak.deleteRealm(realmName("tenant", code));
}
