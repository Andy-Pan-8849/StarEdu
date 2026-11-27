// 字典、参数、操作日志、账号凭据操作（临时密码等）、在线用户（读 Keycloak）。
import { claimsOf, Harness } from "../helpers/app";

describe("dictionaries, parameters, operation log, credentials, online users", () => {
  const h = new Harness();
  let bossToken: string;
  const admin = () => h.call(bossToken);

  beforeAll(async () => {
    await h.start();
    bossToken = await (await h.user("boss", { roles: ["tenant-admin"], person: "staff" })).token();
  });
  afterAll(() => h.stop());

  describe("dictionaries", () => {
    it("platform dictionaries are read-only for the tenant and carry translation keys", async () => {
      const types = (await admin().get("/api/dict-types")).body as Array<{ id: string; code: string; platformProvided: boolean; nameKey: string | null }>;
      const gender = types.find((t) => t.code === "gender")!;
      expect(gender).toMatchObject({ platformProvided: true, nameKey: "dict.type.gender" });
      expect((await admin().patch(`/api/dict-types/${gender.id}`, { name: "x" })).status).toBe(403);
      expect((await admin().del(`/api/dict-types/${gender.id}`)).status).toBe(403);
      const items = (await admin().get(`/api/dict-types/${gender.id}/items`)).body as Array<{ id: string }>;
      expect((await admin().patch(`/api/dict-items/${items[0].id}`, { label: "x" })).status).toBe(403);
      expect((await admin().del(`/api/dict-items/${items[0].id}`)).status).toBe(403);
      const dropdown = (await admin().get("/api/dicts/gender")).body;
      expect(dropdown.items.map((i: { value: string }) => i.value)).toEqual(["male", "female", "other", "unknown"]);
      expect(dropdown.items[0].labelKey).toBe("dict.gender.male");
      // 学生门户的请求走 /api/portal/*，也能读同一个字典（学位计划页要把学位类型翻成文字）
      expect((await admin().get("/api/portal/dicts/gender")).body).toEqual(dropdown);
    });

    it("a tenant can append its own entries to a platform dictionary; built-in entries stay read-only; other tenants do not see them", async () => {
      const types = (await admin().get("/api/dict-types")).body as Array<{ id: string; code: string }>;
      const degree = types.find((t) => t.code === "degree_type")!;
      expect((await admin().post(`/api/dict-types/${degree.id}/items`, { value: "bachelor", label: "Dup" })).status).toBe(409); // 和平台条目重复
      const mine = (await admin().post(`/api/dict-types/${degree.id}/items`, { value: "diploma", label: "Diploma", remark: "Two-year program" })).body;
      expect((await admin().get("/api/dicts/degree_type")).body.items.map((i: { value: string }) => i.value)).toContain("diploma");
      expect((await admin().patch(`/api/dict-items/${mine.id}`, { label: "Higher diploma" })).status).toBe(200);
      const other = await h.extraTenant();
      await h.owner.dictItem.create({ data: { tenantId: other.tenantId, typeId: degree.id, value: "diploma", label: "Theirs" } }); // 不同租户可以用同一个值
      await h.owner.dictItem.deleteMany({ where: { tenantId: other.tenantId, typeId: degree.id } });
      expect((await admin().del(`/api/dict-items/${mine.id}`)).status).toBe(200);
      expect((await admin().get("/api/dicts/degree_type")).body.items.map((i: { value: string }) => i.value)).not.toContain("diploma");
    });

    it("a tenant can build its own dictionary; codes cannot clash with platform ones; disabled items leave the dropdown", async () => {
      expect((await admin().post("/api/dict-types", { code: "gender", name: "Clash" })).status).toBe(409);
      expect((await admin().post("/api/dict-types", { code: "Bad Code", name: "x" })).status).toBe(400);
      const type = (await admin().post("/api/dict-types", { code: "club", name: "Clubs" })).body;
      const robotics = (await admin().post(`/api/dict-types/${type.id}/items`, { value: "robotics", label: "Robotics", sort: 1 })).body;
      await admin().post(`/api/dict-types/${type.id}/items`, { value: "chess", label: "Chess", sort: 2 });
      expect((await admin().post(`/api/dict-types/${type.id}/items`, { value: "chess", label: "Dup" })).status).toBe(409);
      expect((await admin().get("/api/dicts/club")).body.items.map((i: { value: string }) => i.value)).toEqual(["robotics", "chess"]);
      expect((await admin().patch(`/api/dict-items/${robotics.id}`, { status: false })).status).toBe(200);
      expect((await admin().get("/api/dicts/club")).body.items.map((i: { value: string }) => i.value)).toEqual(["chess"]); // 立即生效，没有缓存
      expect((await admin().patch(`/api/dict-types/${type.id}`, { status: false })).status).toBe(200);
      expect((await admin().get("/api/dicts/club")).status).toBe(404);
      expect((await admin().del(`/api/dict-types/${type.id}`)).status).toBe(200);
      expect((await admin().post("/api/dict-types", { code: "club", name: "Reused" })).status).toBe(201);
      expect((await admin().get("/api/dicts/Not-A-Code")).status).toBe(400);
    });

    it("items can carry a remark, and a field that uses a dictionary only accepts its enabled values", async () => {
      const type = (await admin().post("/api/dict-types", { code: "remarked", name: "Remarked", remark: "What this list is for" })).body;
      const item = (await admin().post(`/api/dict-types/${type.id}/items`, { value: "a", label: "A", remark: "Means the first one" })).body;
      expect(item.remark).toBe("Means the first one");
      expect((await admin().patch(`/api/dict-items/${item.id}`, { remark: "Changed" })).body.remark).toBe("Changed");
      const platform = (await admin().get("/api/dict-types")).body as Array<{ code: string; platformProvided: boolean }>;
      expect(platform.filter((t) => t.platformProvided).map((t) => t.code)).toEqual(expect.arrayContaining(["gender", "employment_type", "degree_type", "relationship", "material_category"]));
      const bad = await admin().post("/api/staff", { fullName: "Dict Check", hireDate: "2024-01-01", employmentType: "contract" });
      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.body)).toContain("full_time");
    });

    it("two tenants can each have their own dictionary with the same code", async () => {
      const other = await h.extraTenant();
      await h.owner.dictType.create({ data: { tenantId: other.tenantId, code: "shared_code", name: "Other tenant's" } });
      expect((await admin().post("/api/dict-types", { code: "shared_code", name: "Mine" })).status).toBe(201);
    });
  });

  describe("parameters", () => {
    it("platform parameters are defaults a tenant can override and restore; tenant parameters can be edited", async () => {
      const list = (await admin().get("/api/params")).body as Array<{ id: string; key: string; platformProvided: boolean }>;
      const platform = list.find((p) => p.key === "system.ui.defaultLocale")!;
      expect(platform.platformProvided).toBe(true);
      expect((await admin().patch(`/api/params/${platform.id}`, { value: "zh" })).status).toBe(403);
      expect((await admin().del(`/api/params/${platform.id}`)).status).toBe(403);
      // 覆盖平台默认：值要符合登记的范围；覆盖后列表里该键只出现一次，显示本租户的值和默认值；删除覆盖恢复默认
      expect((await admin().post("/api/params", { key: "system.ui.defaultLocale", value: "fr", name: "x" })).status).toBe(400);
      const override = (await admin().post("/api/params", { key: "system.ui.defaultLocale", value: "zh", name: "x" })).body;
      expect((await admin().post("/api/params", { key: "system.ui.defaultLocale", value: "en", name: "x" })).status).toBe(409);
      const after = ((await admin().get("/api/params")).body as Array<{ key: string; value: string; overridden: boolean; defaultValue: string | null; platformProvided: boolean }>).filter((p) => p.key === "system.ui.defaultLocale");
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ value: "zh", overridden: true, defaultValue: "en", platformProvided: false });
      expect((await admin().patch(`/api/params/${override.id}`, { value: "nope" })).status).toBe(400);
      expect((await admin().del(`/api/params/${override.id}`)).status).toBe(200);
      expect(((await admin().get("/api/params")).body as Array<{ key: string; value: string }>).find((p) => p.key === "system.ui.defaultLocale")?.value).toBe("en");
      expect((await admin().post("/api/params", { key: "Bad Key", value: "1", name: "x" })).status).toBe(400);
      expect((await admin().post("/api/params", { key: "library.upload.maxMb", value: "0", name: "x" })).status).toBe(400);
      expect((await admin().post("/api/params", { key: "edu.extension.maxDays", value: "31", name: "x" })).status).toBe(400);
      const mine = (await admin().post("/api/params", { key: "school.openHour", value: "8", name: "Opening hour" })).body;
      expect((await admin().patch(`/api/params/${mine.id}`, { value: "9" })).body.value).toBe("9");
      expect((await admin().patch(`/api/params/${mine.id}`, { key: "x" })).status).toBe(400);
      expect((await admin().del(`/api/params/${mine.id}`)).status).toBe(200);
      expect((await admin().post("/api/params", { key: "school.openHour", value: "7", name: "Again" })).status).toBe(201);
    });
  });

  describe("operation log", () => {
    const logs = async () => (await admin().get("/api/operation-logs?size=100")).body as Array<{ method: string; path: string; status: number; username: string; params: { body?: Record<string, unknown> } | null; error: string | null; ip: string | null }>;
    // 操作日志是请求结束后异步写入的：测试必须等到"自己要看的那一行"出现，而不是"任何一行"（前面的用例也写过 400），
    // 超时要报错，不能默默放过去。
    type Row = Awaited<ReturnType<typeof logs>>[number];
    const rowWhere = async (pred: (l: Row) => boolean, what: string): Promise<Row> => {
      for (let i = 0; i < 100; i += 1) {
        const found = (await logs()).find(pred);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`operation log row not written within 10 s: ${what}`);
    };

    it("records who did what with sanitized parameters, never the response, for writes only", async () => {
      await admin().post("/api/posts", { code: "logged-post", name: "Logged" });
      await admin().get("/api/posts"); // 读不记
      await admin().post("/api/params", { key: "log.test.password", value: "secret-value-123", name: "Secret one", remark: "r" });
      await rowWhere((l) => l.path === "/api/posts" && l.method === "POST", "POST /api/posts");
      await rowWhere((l) => l.path === "/api/params" && l.method === "POST", "POST /api/params");
      const rows = await logs();
      expect(rows.every((l) => l.method !== "GET")).toBe(true);
      const post = rows.find((l) => l.path === "/api/posts" && l.method === "POST")!;
      expect(post).toMatchObject({ username: "boss", status: 201 });
      expect(post.params?.body).toEqual({ code: "logged-post", name: "Logged" });
      expect(post.ip).toBeTruthy();
      expect(Object.keys(post).filter((k) => /response|result|body/i.test(k))).toEqual([]); // 返回内容不记（日志里没有这样的列）
    });

    it("masks passwords and tokens in the stored parameters", async () => {
      await admin().post("/api/accounts", { username: "log.user", email: "log.user@example.test", sendInvite: false, password: "Hunter2!Hunter2", token: "abc" } as never).catch(() => undefined);
      const row = await rowWhere((l) => l.path === "/api/accounts" && l.method === "POST", "POST /api/accounts");
      expect(row.params?.body).toMatchObject({ password: "***", token: "***", username: "log.user" });
    });

    it("failed requests are recorded with their status and message", async () => {
      await admin().post("/api/posts", { code: "Bad Code", name: "x" });
      const bad = await rowWhere((l) => l.status === 400 && l.path === "/api/posts", "POST /api/posts with status 400");
      expect(bad.error).toBeTruthy();
    });

    it("anyone without the list permission cannot read it; clearing needs its own permission and is itself audited", async () => {
      const viewer = await h.user("viewer", { person: "staff" });
      expect((await h.call(await viewer.token()).get("/api/operation-logs")).status).toBe(403);
      // 给一个只有"列表"权限的角色
      const menus = (await admin().get("/api/menus")).body as Array<{ id: string; code: string | null }>;
      const byCode = new Map(menus.map((m) => [m.code, m.id]));
      const role = (await admin().post("/api/roles", { code: "log-reader", name: "Log reader" })).body.id;
      await admin().put(`/api/roles/${role}/menus`, { menuIds: [byCode.get("system"), byCode.get("system:operationLog")] });
      await admin().put(`/api/accounts/${viewer.accountId}/roles`, { roleIds: [role] });
      const vt = await viewer.token();
      expect((await h.call(vt).get("/api/operation-logs")).status).toBe(200);
      expect((await h.call(vt).del("/api/operation-logs")).status).toBe(403);

      const cleared = await admin().del("/api/operation-logs");
      expect(cleared.status).toBe(200);
      expect(cleared.body.deleted).toBeGreaterThan(0);
      const audit = (await admin().get("/api/audit-logs?size=50")).body as Array<{ action: string }>;
      expect(audit.map((a) => a.action)).toContain("operationLog.clear"); // 清空本身不会被清掉
    });

    it("old parameters are removed by the purge job but the entry stays", async () => {
      const old = await h.owner.operationLog.create({ data: { tenantId: h.tenant.tenantId, method: "POST", path: "/api/old", status: 200, durationMs: 1, params: { body: { a: 1 } }, createdAt: new Date(Date.now() - 200 * 864e5) } });
      const fresh = await h.owner.operationLog.create({ data: { tenantId: h.tenant.tenantId, method: "POST", path: "/api/fresh", status: 200, durationMs: 1, params: { body: { a: 1 } } } });
      const { JOBS } = await import("../../src/platform/jobs/job-registry");
      const job = JOBS.find((j) => j.code === "logs.purge-params")!;
      await job.run({ db: h.owner as never, accounts: null as never, staff: null as never, notify: null as never });
      expect((await h.owner.operationLog.findUniqueOrThrow({ where: { id: old.id } })).params).toBeNull();
      expect((await h.owner.operationLog.findUniqueOrThrow({ where: { id: old.id } })).path).toBe("/api/old");
      expect((await h.owner.operationLog.findUniqueOrThrow({ where: { id: fresh.id } })).params).not.toBeNull();
    });
  });

  describe("account credentials", () => {
    it("generates a temporary password shown once, forces a change at next sign-in, and never writes it to a log", async () => {
      const target = await h.user("pw.target", { person: "staff" });
      const res = await admin().post(`/api/accounts/${target.accountId}/temp-password`);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ mustChange: true });
      const pw = res.body.password as string;
      expect(pw).toHaveLength(12);
      // Keycloak 里该用户被要求改密：用临时密码换令牌会被要求先更新密码
      const login = await fetch(`${h.keycloak.url}/realms/${h.realm}/protocol/openid-connect/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "password", client_id: "portal", username: "pw.target", password: pw }),
      });
      expect(login.status).toBe(400);
      expect(((await login.json()) as { error_description: string }).error_description).toMatch(/not fully set up|required action/i);
      const kcId = (await h.owner.account.findUniqueOrThrow({ where: { id: target.accountId } })).keycloakUserId as string;
      expect((await h.keycloak.getUser(h.realm, kcId))?.requiredActions).toContain("UPDATE_PASSWORD");
      // 密码不在任何日志里
      const everything = JSON.stringify([(await admin().get("/api/audit-logs?size=100")).body, (await admin().get("/api/operation-logs?size=100")).body]);
      expect(everything).not.toContain(pw);
    });

    it("resends an invitation, sends a reset link, and unlocks; the built-in administrator is for platform administrators only", async () => {
      const t = await h.user("link.target", { person: "staff" });
      expect((await admin().post(`/api/accounts/${t.accountId}/invite`)).body).toEqual({ sent: true });
      expect((await admin().post(`/api/accounts/${t.accountId}/reset-link`)).body).toEqual({ sent: true });
      expect((await admin().post(`/api/accounts/${t.accountId}/unlock`)).body).toEqual({ unlocked: true });
      const builtin = await h.owner.account.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, isBuiltinAdmin: true } });
      expect((await admin().post(`/api/accounts/${builtin.id}/temp-password`)).status).toBe(403);
      expect((await admin().post(`/api/accounts/${builtin.id}/invite`)).status).toBe(403);
      // 没有邮箱：不能发链接，只能临时密码
      await h.owner.account.update({ where: { id: t.accountId }, data: { email: null } });
      expect((await admin().post(`/api/accounts/${t.accountId}/invite`)).status).toBe(400);
      expect((await admin().post(`/api/accounts/${t.accountId}/temp-password`)).status).toBe(201);
    });

    it("the credential actions need their own permission", async () => {
      const t = await h.user("perm.target", { person: "staff" });
      const lowly = await h.user("lowly", { person: "staff" });
      expect((await h.call(await lowly.token()).post(`/api/accounts/${t.accountId}/temp-password`)).status).toBe(403);
    });

    it("account search filters by user name or e-mail", async () => {
      await admin().post("/api/accounts", { username: "findme.one", email: "needle@example.test", sendInvite: false });
      const hit = (await admin().get("/api/accounts?q=NEEDLE")).body as Array<{ username: string }>;
      expect(hit.map((a) => a.username)).toEqual(["findme.one"]);
      expect((await admin().get("/api/accounts?q=zzzznothing")).body).toEqual([]);
    });
  });

  describe("online users read from Keycloak", () => {
    it("lists sessions the identity service knows, including ones that never called the API", async () => {
      const quiet = await h.user("quiet.user", { roles: ["tenant-admin"], person: "staff" });
      const token = await quiet.token(); // 只登录，不调任何接口
      const sid = claimsOf(token).sid as string;
      const list = (await admin().get("/api/online")).body as Array<{ sid: string; username: string; accountId: string; entry: string; ip: string }>;
      const row = list.find((s) => s.sid === sid);
      expect(row).toMatchObject({ username: "quiet.user", accountId: quiet.accountId, entry: "portal" });
      expect(row?.ip).toBeTruthy();
      // 强退：不需要这个会话调过接口
      expect((await admin().del(`/api/online/${sid}`)).status).toBe(200);
      expect((await h.call(token).get("/api/me")).status).toBe(401);
    });
  });
});
