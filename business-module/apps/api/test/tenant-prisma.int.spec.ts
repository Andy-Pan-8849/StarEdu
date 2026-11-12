// Prisma 扩展：不传租户条件也只能读写本租户；没有租户上下文就失败。
import { PrismaService } from "../src/prisma/prisma.service";
import { runInScope, TenantContextMissingError } from "../src/tenancy/request-scope";
import { TenantScopeError } from "../src/tenancy/scope-args";
import { TenantPrismaService } from "../src/tenancy/tenant-prisma.service";
import type { KeycloakAdmin } from "../src/keycloak/keycloak-admin";
import { connectKeycloak, ownerClient, provisionTestTenant, removeTestTenant, type TestTenant } from "./helpers/fixtures";

describe("tenant-aware Prisma client", () => {
  const owner = ownerClient();
  const base = new PrismaService();
  const svc = new TenantPrismaService(base);
  const db = svc.db;
  let keycloak: KeycloakAdmin;
  let a: TestTenant;
  let b: TestTenant;
  let bCampusId: string;
  let templateRoleId: string;

  // Prisma 的查询是惰性的：必须在作用域"里面"await，租户上下文才在执行时还在
  const inA = <T>(fn: () => Promise<T>) =>
    runInScope({ kind: "tenant", tenantId: a.tenantId, code: a.code, name: a.name, status: "active" }, async () => await fn());

  beforeAll(async () => {
    keycloak = await connectKeycloak();
    a = await provisionTestTenant(owner, keycloak);
    b = await provisionTestTenant(owner, keycloak);
    bCampusId = (await owner.campus.findFirstOrThrow({ where: { tenantId: b.tenantId } })).id;
    await owner.post.create({ data: { tenantId: b.tenantId, code: "b-only", name: "B only" } });
    templateRoleId = (await owner.role.create({ data: { tenantId: null, code: `tpl-${a.code}`, name: "Template", isTemplate: true } })).id;
  });
  afterAll(async () => {
    await owner.role.delete({ where: { id: templateRoleId } });
    await removeTestTenant(owner, keycloak, a.code);
    await removeTestTenant(owner, keycloak, b.code);
    await owner.$disconnect();
    await base.$disconnect();
  });

  it("reads only the current tenant, with no tenant condition written", async () => {
    const campuses = await inA(() => db.campus.findMany());
    expect(campuses.length).toBeGreaterThan(0);
    expect(campuses.every((c) => c.tenantId === a.tenantId)).toBe(true);
    expect(await inA(() => db.post.findMany())).toEqual([]); // B 的岗位看不到
  });

  it("a hand-written condition for another tenant finds nothing", async () => {
    expect(await inA(() => db.campus.findMany({ where: { tenantId: b.tenantId } }))).toEqual([]);
    expect(await inA(() => db.campus.count({ where: { tenantId: b.tenantId } }))).toBe(0);
  });

  it("another tenant's row cannot be fetched by id", async () => {
    expect(await inA(() => db.campus.findUnique({ where: { id: bCampusId } }))).toBeNull();
    expect(await inA(() => db.campus.findFirst({ where: { id: bCampusId } }))).toBeNull();
  });

  it("another tenant's row cannot be updated", async () => {
    await expect(inA(() => db.campus.update({ where: { id: bCampusId }, data: { name: "hacked" } }))).rejects.toThrow();
    expect((await inA(() => db.campus.updateMany({ where: { id: bCampusId }, data: { name: "hacked" } }))).count).toBe(0);
    expect((await owner.campus.findUniqueOrThrow({ where: { id: bCampusId } })).name).not.toBe("hacked");
  });

  it("creates rows stamped with the current tenant, and refuses another tenant's id", async () => {
    const post = await inA(() => db.post.create({ data: { code: "p1", name: "Post 1" } as never }));
    expect(post.tenantId).toBe(a.tenantId);
    await expect(inA(() => db.post.create({ data: { code: "p2", name: "Post 2", tenantId: b.tenantId } as never }))).rejects.toThrow(TenantScopeError);
  });

  it("fails closed without a tenant (or on the platform host)", async () => {
    await expect(db.campus.findMany()).rejects.toThrow(TenantContextMissingError);
    await expect(runInScope({ kind: "platform" }, async () => await db.campus.findMany())).rejects.toThrow(TenantContextMissingError);
  });

  it("sees platform roles but cannot change them; its own roles are stamped", async () => {
    const roles = await inA(() => db.role.findMany());
    expect(roles.some((r) => r.id === templateRoleId)).toBe(true);
    await expect(inA(() => db.role.update({ where: { id: templateRoleId }, data: { name: "x" } }))).rejects.toThrow();
    const mine = await inA(() => db.role.create({ data: { code: "mine", name: "Mine" } as never }));
    expect(mine.tenantId).toBe(a.tenantId);
  });

  it("soft-deleted rows disappear; hard delete is refused", async () => {
    const post = await inA(() => db.post.create({ data: { code: "gone", name: "Gone" } as never }));
    await inA(() => db.post.update({ where: { id: post.id }, data: { deletedAt: new Date() } }));
    expect((await inA(() => db.post.findMany())).some((p) => p.id === post.id)).toBe(false);
    expect(await inA(() => db.post.findUnique({ where: { id: post.id } }))).toBeNull();
    await expect(inA(() => db.post.delete({ where: { id: post.id } }))).rejects.toThrow(TenantScopeError);
  });

  it("a transaction is atomic and keeps the tenant on every step", async () => {
    await expect(
      inA(() =>
        svc.transaction(async (tx) => {
          await tx.post.create({ data: { code: "t1", name: "T1" } as never });
          await tx.post.create({ data: { code: "t2", name: "T2" } as never });
          throw new Error("rollback");
        }),
      ),
    ).rejects.toThrow("rollback");
    expect((await inA(() => db.post.findMany({ where: { code: { in: ["t1", "t2"] } } }))).length).toBe(0);

    await inA(() =>
      svc.transaction(async (tx) => {
        await tx.post.create({ data: { code: "t3", name: "T3" } as never });
        expect((await tx.post.findMany({ where: { code: "t3" } })).length).toBe(1);
        await expect(tx.post.create({ data: { code: "t4", name: "T4", tenantId: b.tenantId } as never })).rejects.toThrow(TenantScopeError);
      }),
    );
    expect((await owner.post.findMany({ where: { code: "t3" } }))[0].tenantId).toBe(a.tenantId);
  });
});
