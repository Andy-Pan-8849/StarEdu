import { filterSoftDeleted, scopeArgs, TenantScopeError } from "../../src/tenancy/scope-args";

const T = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

describe("scopeArgs", () => {
  it("adds the tenant (and not-deleted) to every read", () => {
    const out = scopeArgs("Campus", "findMany", { where: { name: "x" } }, T);
    expect(out?.where).toEqual({ AND: [{ AND: [{ name: "x" }, { tenantId: T }] }, { deletedAt: null }] });
  });

  it("a caller-supplied tenant condition cannot widen the result", () => {
    const out = scopeArgs("Campus", "findMany", { where: { tenantId: OTHER } }, T);
    // 两个条件取"并且"：tenantId=OTHER 且 tenantId=T，永远查不到任何行
    expect(JSON.stringify(out?.where)).toContain(OTHER);
    expect(JSON.stringify(out?.where)).toContain(T);
    expect(out?.where.AND[0].AND).toHaveLength(2);
  });

  it("includes platform rows (tenant_id null) when reading nullable models", () => {
    const out = scopeArgs("Role", "findMany", undefined, T);
    expect(JSON.stringify(out?.where)).toContain(JSON.stringify({ OR: [{ tenantId: T }, { tenantId: null }] }));
  });

  it("lets a caller ask explicitly for soft-deleted rows", () => {
    const out = scopeArgs("Post", "findMany", { where: { deletedAt: { not: null } } }, T);
    expect(JSON.stringify(out?.where)).not.toContain('{"deletedAt":null}');
  });

  it("stamps tenantId on create and refuses another tenant", () => {
    expect(scopeArgs("Post", "create", { data: { code: "a", name: "A" } }, T)?.data.tenantId).toBe(T);
    expect(() => scopeArgs("Post", "create", { data: { code: "a", name: "A", tenantId: OTHER } }, T)).toThrow(TenantScopeError);
  });

  it("stamps every row of createMany", () => {
    const out = scopeArgs("Post", "createMany", { data: [{ code: "a" }, { code: "b" }] }, T);
    expect(out?.data.map((r: { tenantId: string }) => r.tenantId)).toEqual([T, T]);
  });

  it("restricts unique reads and writes to the tenant, and writes of nullable models too", () => {
    expect(scopeArgs("Campus", "findUnique", { where: { id: "x" } }, T)?.where).toEqual({ id: "x", tenantId: T });
    expect(scopeArgs("Role", "update", { where: { id: "x" }, data: { name: "n" } }, T)?.where).toEqual({ id: "x", tenantId: T });
    expect(scopeArgs("Role", "updateMany", { data: { name: "n" } }, T)?.where).toEqual({ tenantId: T });
  });

  it("refuses changing tenantId, and hard delete of soft-deletable models", () => {
    expect(() => scopeArgs("Post", "update", { where: { id: "x" }, data: { tenantId: OTHER } }, T)).toThrow(TenantScopeError);
    expect(() => scopeArgs("Post", "updateMany", { data: { tenantId: OTHER } }, T)).toThrow(TenantScopeError);
    expect(() => scopeArgs("Post", "delete", { where: { id: "x" } }, T)).toThrow(/hard delete/);
    expect(() => scopeArgs("Account", "deleteMany", {}, T)).toThrow(/hard delete/);
  });

  it("allows hard delete for link tables without soft delete", () => {
    expect(scopeArgs("AccountRole", "deleteMany", { where: { roleId: "r" } }, T)?.where.AND[1]).toEqual({ tenantId: T });
  });

  it("rejects operations it does not understand instead of passing them through", () => {
    expect(() => scopeArgs("Post", "someNewOperation", {}, T)).toThrow(TenantScopeError);
  });

  it("leaves models that are not tenant-scoped alone", () => {
    expect(scopeArgs("Entry", "findMany", { where: { code: "admin" } }, T)).toEqual({ where: { code: "admin" } });
  });
});

describe("filterSoftDeleted", () => {
  it("hides soft-deleted rows from unique reads", () => {
    expect(filterSoftDeleted("Post", "findUnique", { id: "x", deletedAt: new Date() })).toBeNull();
    expect(() => filterSoftDeleted("Post", "findUniqueOrThrow", { id: "x", deletedAt: new Date() })).toThrow(TenantScopeError);
    expect(filterSoftDeleted("Post", "findUnique", { id: "x", deletedAt: null })).toEqual({ id: "x", deletedAt: null });
    expect(filterSoftDeleted("Post", "findMany", [{ deletedAt: new Date() }])).toHaveLength(1);
  });
});
