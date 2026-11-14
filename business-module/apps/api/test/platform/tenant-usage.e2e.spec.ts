// 使用情况与配额：平台看每个租户的账号数/存储用量，设上限；租户请求里超限被拒绝（新增账号 409、上传申请 413），
// 已有数据不动；去掉上限立即恢复。真实对象存储和 Keycloak。
import { Harness } from "../helpers/app";
import { appClient } from "../helpers/fixtures";
import { PlatformFixture, platformCall } from "../helpers/platform";

describe("tenant usage and quota", () => {
  const h = new Harness();
  let fx: PlatformFixture;
  let token: string;
  let boss: string;
  let folderId: string;
  const root = () => platformCall(h.app, token);
  const tenantId = () => h.tenant.tenantId;
  const quotaUrl = () => `/api/platform/tenants/${tenantId()}/quota`;
  const usageUrl = () => `/api/platform/tenants/${tenantId()}/usage`;
  const setQuota = (maxAccounts: number | null, maxStorageMb: number | null) => root().put(quotaUrl(), { maxAccounts, maxStorageMb });
  const accountCount = () => h.owner.account.count({ where: { tenantId: tenantId(), deletedAt: null, isService: false } });
  const requestUpload = (size: number, name = "q.txt") => h.call(boss).post(`/api/library/folders/${folderId}/uploads`, { name, size, contentType: "text/plain" });

  beforeAll(async () => {
    process.env.JOBS_SCHEDULER = "off";
    await h.start();
    fx = new PlatformFixture(h.owner, h.keycloak);
    await fx.setup();
    token = await (await fx.user("p.quota", { roles: ["platform-super"] })).token();
    boss = await (await h.user("boss", { roles: ["tenant-admin"], person: "staff" })).token();
    const res = await h.call(boss).post("/api/library/folders", { name: "Quota", classification: "internal" });
    expect(res.status).toBe(201);
    folderId = res.body.id;
  });
  afterAll(async () => {
    await fx.cleanup();
    await h.stop();
  });

  it("shows usage with no limit by default", async () => {
    const res = await root().get(usageUrl());
    expect(res.status).toBe(200);
    expect(res.body.limits).toEqual({ maxAccounts: null, maxStorageMb: null });
    expect(res.body.usage.accounts).toBe(await accountCount());
    expect(res.body.accountsMeter).toMatchObject({ limit: null, percent: null, full: false });
    const list = await root().get("/api/platform/tenants/usage");
    expect(list.status).toBe(200);
    expect(list.body.find((r: { tenantId: string }) => r.tenantId === tenantId())).toBeTruthy();
  });

  it("rejects invalid limits and unknown fields; changes are audited", async () => {
    const since = new Date();
    expect((await setQuota(0, null)).status).toBe(400);
    expect((await setQuota(null, -5)).status).toBe(400);
    expect((await setQuota(1.5, null)).status).toBe(400);
    expect((await root().put(quotaUrl(), { maxAccounts: 5, maxStorageMb: null, extra: 1 })).status).toBe(400);
    expect((await setQuota(500, 2048)).status).toBe(200);
    const row = await h.owner.platformAuditLog.findFirst({ where: { action: "tenant.quota", targetId: tenantId(), createdAt: { gte: since } }, orderBy: { createdAt: "asc" } });
    expect(row?.detail).toMatchObject({ before: { maxAccounts: null, maxStorageMb: null }, after: { maxAccounts: 500, maxStorageMb: 2048 } });
    await setQuota(null, null);
  });

  it("refuses new accounts at the limit, keeps existing ones, and recovers when the limit is raised", async () => {
    const used = await accountCount();
    expect((await setQuota(used, null)).status).toBe(200);
    const blocked = await h.call(boss).post("/api/accounts", { username: "over.limit", email: "over.limit@example.test" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toMatch(/quota/i);
    expect(await h.owner.account.count({ where: { tenantId: tenantId(), username: "over.limit" } })).toBe(0); // 没有留下半个账号
    expect((await setQuota(used + 1, null)).status).toBe(200);
    expect((await h.call(boss).post("/api/accounts", { username: "within.limit", email: "within.limit@example.test" })).status).toBe(201);
    expect((await h.call(boss).post("/api/accounts", { username: "over.again" })).status).toBe(409);
    // 上限降到已有数量以下：已有账号不动，只拒绝新增
    expect((await setQuota(1, null)).status).toBe(200);
    expect(await accountCount()).toBe(used + 1);
    const view = await root().get(usageUrl());
    expect(view.body.accountsMeter).toMatchObject({ full: true, over: true });
    expect((await setQuota(null, null)).status).toBe(200);
    expect((await h.call(boss).post("/api/accounts", { username: "unlimited.again" })).status).toBe(201);
  });

  it("counts uploaded files as storage and refuses an upload request that would exceed the limit", async () => {
    const bytes = Buffer.alloc(300 * 1024, "a"); // 300 KB
    const up = await requestUpload(bytes.length);
    expect(up.status).toBe(201);
    expect((await fetch(up.body.uploadUrl, { method: "PUT", headers: up.body.headers, body: bytes })).status).toBe(200);
    expect((await h.call(boss).post(`/api/library/folders/${folderId}/uploads/confirm`, { uploadId: up.body.uploadId })).status).toBe(201);

    const usage = (await root().get(usageUrl())).body;
    expect(usage.usage.libraryFiles).toBeGreaterThanOrEqual(1);
    expect(usage.usage.storageBytes).toBeGreaterThanOrEqual(bytes.length);

    expect((await setQuota(null, 1)).status).toBe(200); // 1 MB
    expect((await requestUpload(500 * 1024, "fits.txt")).status).toBe(201); // 300 KB + 500 KB < 1 MB
    const refused = await requestUpload(900 * 1024, "too-big.txt"); // 300 KB + 900 KB > 1 MB
    expect(refused.status).toBe(413);
    expect(refused.body.message).toMatch(/storage quota/i);
    expect((await setQuota(null, null)).status).toBe(200);
    expect((await requestUpload(900 * 1024, "now-ok.txt")).status).toBe(201);
  });

  it("another tenant's data never counts, and the tenant side cannot read or change limits", async () => {
    // 租户请求的受限函数只返回本租户的上限
    await setQuota(7, 9);
    const rows = await h.owner.$queryRaw<{ max_accounts: number | null }[]>`SELECT max_accounts FROM biz."tenant" WHERE id = ${tenantId()}::uuid`;
    expect(rows[0]?.max_accounts).toBe(7);
    // 应用账号改不了租户表（没有更新权限），但设好租户会话变量后能用函数读到自己的上限
    const app = appClient();
    try {
      await expect(app.$executeRaw`UPDATE biz."tenant" SET max_accounts = 99999 WHERE id = ${tenantId()}::uuid`).rejects.toThrow(/permission denied/);
      const limits = await app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId()}, true)`;
        return tx.$queryRaw<{ max_accounts: number | null }[]>`SELECT max_accounts FROM biz.tenant_limits()`;
      });
      expect(limits).toEqual([{ max_accounts: 7 }]);
      expect(await app.$queryRaw`SELECT max_accounts FROM biz.tenant_limits()`).toEqual([]); // 没有租户会话变量 = 什么都没有
    } finally {
      await app.$disconnect();
    }
    expect((await h.owner.tenant.findUniqueOrThrow({ where: { id: tenantId() } })).maxAccounts).toBe(7);
    await setQuota(null, null);
  });

  it("needs the platform permission and a platform token", async () => {
    expect((await h.call(boss).get("/api/platform/tenants/usage")).status).toBeGreaterThanOrEqual(401);
    const plain = await (await fx.user("p.noquota", { roles: [] })).token();
    expect((await platformCall(h.app, plain).get(usageUrl())).status).toBe(403);
    expect((await platformCall(h.app, plain).put(quotaUrl(), { maxAccounts: 3, maxStorageMb: null })).status).toBe(403);
    expect((await root().get(`/api/platform/tenants/11111111-1111-4111-8111-111111111111/usage`)).status).toBe(404);
  });
});
