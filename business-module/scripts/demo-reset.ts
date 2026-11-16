// 一键重置演示公司：清空它的全部业务数据（人员、教学、消息、文档、账号……），保留公司本身、登录域、内置管理员、
// 角色和菜单授权、部门和校区；之后 `pnpm demo:reset` 会重新导入样本并生成演示数据，结果每次一样。
// 只对带"演示"标记的公司运行；任何生产公司都不会被碰。Keycloak 里的演示用户一并删除（账号编号会重新生成）。
//   pnpm demo:reset            （= 本脚本 + pnpm import:sample + pnpm seed:demo）
import { parseArgs } from "node:util";
import { Prisma, PrismaClient } from "../apps/api/src/generated/prisma";
import { KeycloakAdmin } from "../apps/api/src/keycloak/keycloak-admin";
import { loadLocalEnv } from "./lib/keycloak";

/** 保留的表：公司本身和它的结构（部门、校区、角色、授权、字典、参数）。 */
const KEEP = new Set(["tenant", "tenant_menu_grant", "role", "role_menu", "role_data_scope", "data_scope_set", "data_scope_set_node", "dept", "campus", "post", "dict_type", "dict_item", "sys_param", "account", "account_role", "menu", "entry_menu"]);

async function main(): Promise<void> {
  loadLocalEnv();
  const { values } = parseArgs({ options: { code: { type: "string", multiple: true } } });
  const owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
  const keycloak = await KeycloakAdmin.connect().catch(() => null);
  try {
    const codes = values.code?.length ? values.code : ["hq", "riverside-franchise"];
    const tables = Prisma.dmmf.datamodel.models
      .filter((m) => m.fields.some((f) => f.name === "tenantId") && !KEEP.has(m.dbName ?? m.name))
      .map((m) => m.dbName ?? m.name);
    for (const code of codes) {
      const tenant = await owner.tenant.findUnique({ where: { code } });
      if (!tenant) continue;
      if (!tenant.isDemo) throw new Error(`tenant "${code}" is not marked as a demo company; refusing to reset it`);
      // 外键顺序不用手写：反复删，直到一轮下来没有进展
      const left = new Set(tables);
      for (let pass = 0; pass < 20 && left.size; pass++) {
        const before = left.size;
        for (const t of [...left]) {
          try {
            await owner.$executeRawUnsafe(`DELETE FROM biz."${t}" WHERE tenant_id = '${tenant.id}'::uuid`);
            left.delete(t);
          } catch {
            /* 被别的表引用，下一轮再试 */
          }
        }
        if (left.size === before) break;
      }
      if (left.size) throw new Error(`could not clear: ${[...left].join(", ")}`);
      // 账号：只留内置管理员
      await owner.accountRole.deleteMany({ where: { tenantId: tenant.id, account: { isBuiltinAdmin: false } } });
      await owner.$executeRawUnsafe(`DELETE FROM biz."account" WHERE tenant_id = '${tenant.id}'::uuid AND NOT is_builtin_admin`);
      // 演示角色连同它的菜单一起删（下次演示数据会重建）
      const demoRole = await owner.role.findFirst({ where: { tenantId: tenant.id, code: "demo-superuser" } });
      if (demoRole) {
        await owner.roleMenu.deleteMany({ where: { roleId: demoRole.id } });
        await owner.roleDataScope.deleteMany({ where: { roleId: demoRole.id } });
        await owner.role.delete({ where: { id: demoRole.id } });
      }
      await owner.tenant.update({ where: { id: tenant.id }, data: { maxAccounts: null, maxStorageMb: null } });
      if (keycloak) {
        const realm = `tenant-${code}`;
        const builtin = await owner.account.findMany({ where: { tenantId: tenant.id, isBuiltinAdmin: true }, select: { keycloakUserId: true } });
        const keep = new Set(builtin.map((b) => b.keycloakUserId));
        for (const u of await keycloak.listUsers(realm)) if (u.id && !keep.has(u.id)) await keycloak.deleteUser(realm, u.id);
      }
      console.log(`reset: ${code} cleared`);
    }
    // 平台演示运营账号：Keycloak 用户和账号行也重建
    if (keycloak) {
      const op = await owner.platformAccount.findUnique({ where: { username: "demo.operator" } });
      if (op) {
        if (op.keycloakUserId) await keycloak.deleteUser("platform", op.keycloakUserId);
        await owner.platformAccountRole.deleteMany({ where: { accountId: op.id } });
        await owner.platformAccount.delete({ where: { id: op.id } });
      }
    }
  } finally {
    await owner.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
