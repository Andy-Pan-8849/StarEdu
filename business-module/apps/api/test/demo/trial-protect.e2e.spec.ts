// 公开试用站保护：开关关着时一切照旧；开着时只对演示公司（和平台入口）生效，被拒绝的请求在认证之前就返回 trial_restricted。
import { Harness } from "../helpers/app";

describe("trial protection (TRIAL_PROTECT=1)", () => {
  const h = new Harness();
  let token: string;
  const admin = () => h.call(token);
  const was = process.env.TRIAL_PROTECT;

  beforeAll(async () => {
    await h.start();
    token = await (await h.user("boss", { roles: ["tenant-admin"], person: "staff" })).token();
  });
  afterAll(async () => {
    if (was === undefined) delete process.env.TRIAL_PROTECT;
    else process.env.TRIAL_PROTECT = was;
    await h.stop();
  });

  it("does nothing while the switch is off, even for a demo company", async () => {
    delete process.env.TRIAL_PROTECT;
    await h.owner.tenant.update({ where: { id: h.tenant.tenantId }, data: { isDemo: true } });
    const res = await admin().post("/api/accounts", { username: "off.switch", email: "off.switch@example.test" });
    expect(res.status).toBe(201);
  });

  it("refuses credential and account-lifecycle routes on a demo company, with a readable code", async () => {
    process.env.TRIAL_PROTECT = "1";
    const created = await h.owner.account.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, username: "off.switch" } });
    for (const [method, path, body] of [
      ["post", "/api/accounts", { username: "blocked.one", email: "blocked.one@example.test" }],
      ["patch", `/api/accounts/${created.id}/status`, { status: "disabled" }],
      ["patch", `/api/accounts/${created.id}/email`, { email: "x@example.test" }],
      ["post", `/api/accounts/${created.id}/reset-link`, {}],
      ["post", `/api/accounts/${created.id}/temp-password`, {}],
      ["post", `/api/accounts/${created.id}/invite`, {}],
    ] as const) {
      const res = await admin()[method](path, body);
      expect([method, path, res.status, res.body.code]).toEqual([method, path, 403, "trial_restricted"]);
    }
    expect(await h.owner.account.count({ where: { tenantId: h.tenant.tenantId, username: "blocked.one" } })).toBe(0);
    expect((await h.owner.account.findUniqueOrThrow({ where: { id: created.id } })).status).not.toBe("disabled");
  });

  it("still lets the visitor try everything else (reads, roles, other writes)", async () => {
    process.env.TRIAL_PROTECT = "1";
    expect((await admin().get("/api/accounts")).status).toBe(200);
    expect((await admin().post("/api/roles", { code: "trial-role", name: "Trial role", dataScope: "none" })).status).not.toBe(403);
  });

  it("does not touch a company that is not a demo company, even with the switch on", async () => {
    process.env.TRIAL_PROTECT = "1";
    await h.owner.tenant.update({ where: { id: h.tenant.tenantId }, data: { isDemo: false } });
    const res = await admin().post("/api/accounts", { username: "real.company", email: "real.company@example.test" });
    expect(res.status).toBe(201);
  });

  it("closes the platform entry's provisioning and security routes before authentication", async () => {
    process.env.TRIAL_PROTECT = "1";
    const blocked = await h.call(null, "platform.localhost").post("/api/platform/tenants", {});
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("trial_restricted");
    delete process.env.TRIAL_PROTECT;
    expect((await h.call(null, "platform.localhost").post("/api/platform/tenants", {})).status).toBe(401);
  });
});
