// 行级安全：绕过 Prisma 扩展直接写原生 SQL，也只能碰当前租户的行。
import type { PrismaClient } from "../src/generated/prisma";
import type { KeycloakAdmin } from "../src/keycloak/keycloak-admin";
import { appClient, connectKeycloak, ownerClient, provisionTestTenant, removeTestTenant, type TestTenant } from "./helpers/fixtures";

describe("row-level security (raw SQL as the application role)", () => {
  const owner = ownerClient();
  const app = appClient();
  let keycloak: KeycloakAdmin;
  let a: TestTenant;
  let b: TestTenant;
  let templateRoleId: string;

  beforeAll(async () => {
    keycloak = await connectKeycloak();
    a = await provisionTestTenant(owner, keycloak);
    b = await provisionTestTenant(owner, keycloak);
    const t = await owner.role.create({ data: { tenantId: null, code: `tpl-${a.code}`, name: "Template", isTemplate: true } });
    templateRoleId = t.id;
  });

  afterAll(async () => {
    await owner.role.delete({ where: { id: templateRoleId } });
    await removeTestTenant(owner, keycloak, a.code);
    await removeTestTenant(owner, keycloak, b.code);
    await owner.$disconnect();
    await app.$disconnect();
  });

  /** 在一个事务里以某租户身份运行；tenantId 为 null 表示不设置（模拟漏设）。 */
  async function asTenant<T>(client: PrismaClient, tenantId: string | null, run: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return client.$transaction(async (tx) => {
      if (tenantId) await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return run(tx as unknown as PrismaClient);
    });
  }

  it("sees nothing when no tenant is set (default deny), although rows exist", async () => {
    const [{ count: all }] = await owner.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM biz.campus WHERE tenant_id IN (${a.tenantId}::uuid, ${b.tenantId}::uuid)`;
    expect(Number(all)).toBeGreaterThanOrEqual(2);
    const rows = await asTenant(app, null, (tx) => tx.$queryRaw<unknown[]>`SELECT * FROM biz.campus`);
    expect(rows).toEqual([]);
  });

  it("sees only its own rows, in every tenant table", async () => {
    for (const table of ["campus", "dept", "account", "role"]) {
      const rows = await asTenant(app, a.tenantId, (tx) =>
        tx.$queryRawUnsafe<Array<{ tenant_id: string | null }>>(`SELECT tenant_id FROM biz.${table}`),
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.tenant_id === a.tenantId || (table === "role" && r.tenant_id === null))).toBe(true);
    }
  });

  it("cannot insert a row for another tenant", async () => {
    await expect(
      asTenant(app, a.tenantId, (tx) => tx.$executeRaw`INSERT INTO biz.post (tenant_id, code, name) VALUES (${b.tenantId}::uuid, 'x', 'X')`),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot update or delete another tenant's rows (they are invisible)", async () => {
    const updated = await asTenant(app, a.tenantId, (tx) => tx.$executeRaw`UPDATE biz.campus SET name = 'hacked' WHERE tenant_id = ${b.tenantId}::uuid`);
    const deleted = await asTenant(app, a.tenantId, (tx) => tx.$executeRaw`DELETE FROM biz.account WHERE tenant_id = ${b.tenantId}::uuid`);
    expect([updated, deleted]).toEqual([0, 0]);
    const [row] = await owner.$queryRaw<Array<{ name: string }>>`SELECT name FROM biz.campus WHERE tenant_id = ${b.tenantId}::uuid LIMIT 1`;
    expect(row.name).not.toBe("hacked");
  });

  it("cannot move its own row to another tenant", async () => {
    await expect(
      asTenant(app, a.tenantId, (tx) => tx.$executeRaw`UPDATE biz.campus SET tenant_id = ${b.tenantId}::uuid WHERE tenant_id = ${a.tenantId}::uuid`),
    ).rejects.toThrow(/row-level security/);
  });

  it("reads platform-provided rows (tenant_id null) but can neither change nor create them", async () => {
    const visible = await asTenant(app, a.tenantId, (tx) => tx.$queryRaw<unknown[]>`SELECT 1 FROM biz.role WHERE id = ${templateRoleId}::uuid`);
    expect(visible).toHaveLength(1);
    const updated = await asTenant(app, a.tenantId, (tx) => tx.$executeRaw`UPDATE biz.role SET name = 'x' WHERE id = ${templateRoleId}::uuid`);
    const deleted = await asTenant(app, a.tenantId, (tx) => tx.$executeRaw`DELETE FROM biz.role WHERE id = ${templateRoleId}::uuid`);
    expect([updated, deleted]).toEqual([0, 0]);
    await expect(
      asTenant(app, a.tenantId, (tx) => tx.$executeRaw`INSERT INTO biz.role (tenant_id, code, name) VALUES (NULL, 'forged', 'Forged')`),
    ).rejects.toThrow(/row-level security/);
  });

  it("only sees its own tenant record", async () => {
    const rows = await asTenant(app, a.tenantId, (tx) => tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM biz.tenant`);
    expect(rows.map((r) => r.id)).toEqual([a.tenantId]);
  });

  it("does not leak the tenant setting to the next transaction on the same connection", async () => {
    await asTenant(app, a.tenantId, (tx) => tx.$queryRaw`SELECT 1`);
    const rows = await app.$queryRaw<unknown[]>`SELECT * FROM biz.campus`; // 没有事务、没有设置
    expect(rows).toEqual([]);
  });

  it("resolve_tenant finds a tenant by code, and only returns four fields", async () => {
    const rows = await app.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM biz.resolve_tenant(${a.code})`;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(["code", "id", "name", "status"]);
    expect(await app.$queryRaw<unknown[]>`SELECT * FROM biz.resolve_tenant('no-such-tenant')`).toEqual([]);
  });
});
