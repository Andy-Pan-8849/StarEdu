// 部门树：祖先链（含自己）由数据库触发器维护，"本部门及以下" 用数组包含查询 + GIN 索引。
import type { KeycloakAdmin } from "../src/keycloak/keycloak-admin";
import { connectKeycloak, ownerClient, provisionTestTenant, removeTestTenant, type TestTenant } from "./helpers/fixtures";

describe("department tree", () => {
  const owner = ownerClient();
  let keycloak: KeycloakAdmin;
  let t: TestTenant;
  let other: TestTenant;

  beforeAll(async () => {
    keycloak = await connectKeycloak();
    t = await provisionTestTenant(owner, keycloak);
    other = await provisionTestTenant(owner, keycloak);
  });
  afterAll(async () => {
    await removeTestTenant(owner, keycloak, t.code);
    await removeTestTenant(owner, keycloak, other.code);
    await owner.$disconnect();
  });

  const mk = (tenantId: string, name: string, parentId?: string) => owner.dept.create({ data: { tenantId, name, parentId } });
  const anc = async (id: string) => (await owner.dept.findUniqueOrThrow({ where: { id } })).ancestors;
  const subtree = async (tenantId: string, id: string) =>
    (await owner.$queryRaw<Array<{ id: string }>>`SELECT id::text FROM biz.dept WHERE tenant_id = ${tenantId}::uuid AND ancestors @> ARRAY[${id}]::text[]`).map((r) => r.id);

  it("a root has itself as its only ancestor; children append themselves", async () => {
    const root = await owner.dept.findFirstOrThrow({ where: { tenantId: t.tenantId, parentId: null } });
    const a = await mk(t.tenantId, "A", root.id);
    const b = await mk(t.tenantId, "B", a.id);
    expect(await anc(root.id)).toEqual([root.id]);
    expect(await anc(a.id)).toEqual([root.id, a.id]);
    expect(await anc(b.id)).toEqual([root.id, a.id, b.id]);
    expect((await subtree(t.tenantId, a.id)).sort()).toEqual([a.id, b.id].sort());
  });

  it("moving a department rewrites the whole subtree", async () => {
    const root = await owner.dept.findFirstOrThrow({ where: { tenantId: t.tenantId, parentId: null } });
    const x = await mk(t.tenantId, "X", root.id);
    const y = await mk(t.tenantId, "Y", x.id);
    const z = await mk(t.tenantId, "Z", y.id);
    const target = await mk(t.tenantId, "Target", root.id);
    await owner.dept.update({ where: { id: x.id }, data: { parentId: target.id } });
    expect(await anc(x.id)).toEqual([root.id, target.id, x.id]);
    expect(await anc(z.id)).toEqual([root.id, target.id, x.id, y.id, z.id]);
    expect((await subtree(t.tenantId, target.id)).sort()).toEqual([target.id, x.id, y.id, z.id].sort());
    // 旧位置的子树不再包含它们
    expect(await subtree(t.tenantId, root.id)).toEqual(expect.arrayContaining([target.id, x.id, y.id, z.id]));
  });

  it("refuses to move a department under itself or one of its descendants", async () => {
    const root = await owner.dept.findFirstOrThrow({ where: { tenantId: t.tenantId, parentId: null } });
    const p = await mk(t.tenantId, "P", root.id);
    const c = await mk(t.tenantId, "C", p.id);
    await expect(owner.dept.update({ where: { id: p.id }, data: { parentId: c.id } })).rejects.toThrow(/under itself/);
    await expect(owner.dept.update({ where: { id: p.id }, data: { parentId: p.id } })).rejects.toThrow(/under itself/);
  });

  it("refuses a parent that belongs to another tenant", async () => {
    const foreignRoot = await owner.dept.findFirstOrThrow({ where: { tenantId: other.tenantId, parentId: null } });
    await expect(mk(t.tenantId, "Orphan", foreignRoot.id)).rejects.toThrow(/Foreign key constraint/);
  });

  it("the subtree query can use the GIN index", async () => {
    const plan = await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return tx.$queryRaw<Array<{ "QUERY PLAN": string }>>`EXPLAIN SELECT id FROM biz.dept WHERE ancestors @> ARRAY['x']::text[]`;
    });
    expect(plan.map((r) => r["QUERY PLAN"]).join("\n")).toContain("dept_ancestors_idx");
  });
});
