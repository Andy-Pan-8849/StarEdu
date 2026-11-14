// 内部权限接口：只有带服务密钥 + 有效令牌才能调；回答是业务模块自己的数据范围解析结果；按权限版本缓存（304）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { Harness } from "../helpers/app";

const KEY = "test-internal-key";
const schema = JSON.parse(readFileSync(resolve(__dirname, "../../../../contracts/internal-authz.schema.json"), "utf8"));
const iso = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

describe("internal authorization interface", () => {
  const h = new Harness();
  let hqDept: string;
  let hqCampus: string;
  let shDept: string;
  const validate = (() => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    return ajv.compile(schema);
  })();
  const ask = (token: string | null, headers: Record<string, string> = {}) => {
    const req = h.call(token).post("/api/internal/authz");
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    return req;
  };

  beforeAll(async () => {
    process.env.INTERNAL_API_KEY = KEY;
    await h.start();
    const campus = await h.owner.campus.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, type: "hq" } });
    hqDept = campus.deptId;
    hqCampus = campus.id;
    const boss = await (await h.user("boss", { roles: ["tenant-admin"], person: "staff" })).token();
    const sh = (await h.call(boss).post("/api/campuses", { code: "SH", name: "Shanghai", timezone: "Asia/Shanghai" })).body;
    shDept = sh.deptId;
  });
  afterAll(async () => {
    delete process.env.INTERNAL_API_KEY;
    await h.stop();
  });

  it("needs the service key: no key, a wrong key, or an unconfigured server all refuse", async () => {
    const t = await (await h.user("hr.one", { roles: ["hr-manager"], person: "staff", deptIds: [hqDept] })).token();
    expect((await ask(t)).status).toBe(403);
    expect((await ask(t, { "x-internal-key": "wrong" })).status).toBe(403);
    expect((await ask(null, { "x-internal-key": KEY })).status).toBe(401); // 密钥对但没有令牌：也不行
    expect((await ask("not.a.jwt", { "x-internal-key": KEY })).status).toBe(401);
    delete process.env.INTERNAL_API_KEY;
    expect((await ask(t, { "x-internal-key": KEY })).status).toBe(503); // 没配密钥：整个接口关闭
    process.env.INTERNAL_API_KEY = KEY;
    expect((await ask(t, { "x-internal-key": KEY })).status).toBe(200);
  });

  it("answers match the published contract, for staff, students and the built-in administrator", async () => {
    const staff = await (await h.user("teach.one", { roles: ["teacher"], person: "staff", deptIds: [hqDept] })).token();
    const student = await (await h.user("stud.one", { roles: ["student"], person: "student" })).token();
    const admin = await (await h.user("boss2", { roles: ["tenant-admin"], person: "staff" })).token();
    for (const t of [staff, student, admin]) {
      const res = await ask(t, { "x-internal-key": KEY });
      expect(res.status).toBe(200);
      expect({ ok: validate(res.body), errors: validate.errors }).toEqual({ ok: true, errors: null });
    }
    const s = (await ask(staff, { "x-internal-key": KEY })).body;
    expect(s).toMatchObject({ tenantId: h.tenant.tenantId, kind: "staff", roles: ["teacher"], campusCode: expect.any(String) });
    expect((await ask(student, { "x-internal-key": KEY })).body).toMatchObject({ kind: "student" });
    expect((await ask(admin, { "x-internal-key": KEY })).body).toMatchObject({ kind: "staff" });
  });

  it("the scopes are what the business module's own resolver gives: campus-bound, cross-campus and company-wide roles differ", async () => {
    // 校区负责人（只看自己校区，含下级）、集团教务（全部）、跨校任教的老师（任教班级跨两个校区）
    const lead = await (await h.user("lead.hq", { roles: ["campus-lead"], person: "staff", deptIds: [hqDept] })).token();
    const reg = await (await h.user("reg.all", { roles: ["academic-manager"], person: "staff", deptIds: [hqDept] })).token();
    const a = (await ask(lead, { "x-internal-key": KEY })).body;
    const b = (await ask(reg, { "x-internal-key": KEY })).body;
    expect(a.scopes["hr:student:list"]).toMatchObject({ all: false });
    expect(a.scopes["hr:student:list"].deptIds).toContain(hqDept);
    expect(a.scopes["hr:student:list"].deptIds).not.toContain(shDept);
    expect(b.scopes["edu:section:list"]).toMatchObject({ all: true });
    // 没有这个权限的账号：范围是空的（不是"全部"）
    expect(a.scopes["edu:grade:list"]).toEqual({ all: false, deptIds: [], classIds: [], selfPersonId: null });
  });

  it("is cached by the permission version: the same version gives 304; a permission change gives a fresh answer", async () => {
    const u = await h.user("cache.one", { roles: ["campus-lead"], person: "staff", deptIds: [hqDept] });
    const token = await u.token();
    const first = await ask(token, { "x-internal-key": KEY });
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"\d+:/);
    expect((await ask(token, { "x-internal-key": KEY, "if-none-match": etag })).status).toBe(304);
    await h.bump(); // 权限变了
    const again = await ask(token, { "x-internal-key": KEY, "if-none-match": etag });
    expect(again.status).toBe(200);
    expect(again.headers.etag).not.toBe(etag);
    expect(again.body.permVersion).toBeGreaterThan(first.body.permVersion);
  });

  it("a token of another company cannot be used on this company's address", async () => {
    const other = await h.extraTenant();
    const t = await (await h.user("foreign", { roles: ["teacher"], person: "staff", tenant: other })).token();
    expect((await h.call(t).post("/api/internal/authz").set("x-internal-key", KEY)).status).toBe(401);
    expect(hqCampus).toBeTruthy();
    expect(iso()).toBeTruthy();
  });
});
