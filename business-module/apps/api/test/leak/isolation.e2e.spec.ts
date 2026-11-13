// 跨租户泄露扫描（端到端：真实 Postgres + 真实 Keycloak 令牌 + 完整的 Nest 应用）。
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import Redis from "ioredis";
import { AppModule, CONTROLLERS } from "../../src/app.module";
import type { KeycloakAdmin } from "../../src/keycloak/keycloak-admin";
import {
  connectKeycloak,
  createUser,
  giveRole,
  ownerClient,
  provisionTestTenant,
  removeTestTenant,
  type TestTenant,
} from "../helpers/fixtures";
import { LEAK_REGISTRY, MUTATION_REGISTRY, OTHER_ROUTES, type Fixture } from "./registry";
import { listRoutes } from "./routes";

interface Side {
  tenant: TestTenant;
  host: string;
  token: string;
  /** alice：带"租户管理员"角色的教职员工，扫描用她的令牌 */
  aliceId: string;
  ids: Record<Fixture, string>;
  allIds: Set<string>;
}

const TABLES = [
  "role", "menu", "data_scope_set", "data_scope_set_node", "account", "account_role", "person", "person_dept",
  "role_menu", "role_data_scope", "entry_menu", "tenant_menu_grant", "dept", "campus", "post", "audit_log", "dict_type", "dict_item", "sys_param",
];

describe("cross-tenant leak scan", () => {
  const owner = ownerClient();
  let keycloak: KeycloakAdmin;
  let app: INestApplication;
  let a: Side;
  let b: Side;
  const redis = new Redis(process.env.REDIS_URL as string);

  async function build(): Promise<Side> {
    const tenant = await provisionTestTenant(owner, keycloak);
    const tenantId = tenant.tenantId;
    const user = await createUser(owner, keycloak, tenant, "alice");
    const person = await owner.person.create({ data: { tenantId, type: "staff", fullName: "Alice" } });
    await owner.account.update({ where: { id: user.accountId }, data: { personId: person.id } });
    await giveRole(owner, tenantId, user.accountId, "tenant-admin");
    const campus = await owner.campus.findFirstOrThrow({ where: { tenantId } });
    const dept = await owner.dept.create({ data: { tenantId, name: "Dept", parentId: campus.deptId } });
    const post = await owner.post.create({ data: { tenantId, code: "teacher", name: "Teacher" } });
    const extraCampusDept = await owner.dept.create({ data: { tenantId, name: "Second campus" } });
    const extraCampus = await owner.campus.create({
      data: { tenantId, deptId: extraCampusDept.id, code: "SH", name: "Second", timezone: "UTC" },
    });
    const bob = await owner.account.create({ data: { tenantId, username: "bob", status: "active" } });
    const role = await owner.role.findFirstOrThrow({ where: { tenantId, code: "hr-manager" } });
    const menu = await owner.menu.create({ data: { tenantId, name: "Own link", type: "link", route: "https://example.test" } });
    const set = await owner.dataScopeSet.create({ data: { tenantId, code: "custom-scan", name: "Scan set", kind: "custom" } });
    await owner.dataScopeSetNode.create({ data: { tenantId, setId: set.id, deptId: dept.id } });
    const dictType = await owner.dictType.create({ data: { tenantId, code: "scan_dict", name: "Scan dictionary" } });
    const dictItem = await owner.dictItem.create({ data: { tenantId, typeId: dictType.id, value: "one", label: "One" } });
    const param = await owner.sysParam.create({ data: { tenantId, key: "scan.param", value: "1", name: "Scan parameter" } });

    const token = await user.token();
    const sid = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).sid as string;
    const everyId = async (table: string) =>
      (await owner.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text FROM biz.${table} WHERE tenant_id = '${tenantId}'`)).map((r) => r.id);
    const allIds = new Set<string>([tenantId, sid]);
    for (const t of ["role", "menu", "data_scope_set", "account", "person", "dept", "campus", "post", "dict_type", "dict_item", "sys_param"]) (await everyId(t)).forEach((i) => allIds.add(i));
    return {
      tenant,
      host: `${tenant.code}.localhost`,
      token,
      aliceId: user.accountId,
      ids: {
        campusId: campus.id,
        deptId: dept.id,
        postId: post.id,
        roleId: role.id,
        accountId: bob.id,
        personId: person.id,
        menuId: menu.id,
        setId: set.id,
        dictTypeId: dictType.id,
        dictItemId: dictItem.id,
        paramId: param.id,
        sid,
      },
      allIds: new Set([...allIds, extraCampus.id, extraCampusDept.id]),
    };
  }

  beforeAll(async () => {
    keycloak = await connectKeycloak();
    a = await build();
    b = await build();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    await removeTestTenant(owner, keycloak, a.tenant.code);
    await removeTestTenant(owner, keycloak, b.tenant.code);
    await owner.$disconnect();
    redis.disconnect();
  });

  const get = (side: Side, path: string, opts: { host?: string; token?: string | null; headers?: Record<string, string> } = {}) => {
    const req = request(app.getHttpServer()).get(path).set("Host", opts.host ?? side.host);
    const token = opts.token === undefined ? side.token : opts.token;
    if (token) req.set("Authorization", `Bearer ${token}`);
    for (const [k, v] of Object.entries(opts.headers ?? {})) req.set(k, v);
    return req;
  };
  const pathFor = (entry: (typeof LEAK_REGISTRY)[number], side: Side) =>
    (entry.fixture ? entry.path.replace(":id", side.ids[entry.fixture]) : entry.path).replace(":code", "gender");

  it("every route is either public or registered in the leak registry", () => {
    const routes = listRoutes(CONTROLLERS);
    const registered = new Set([
      ...LEAK_REGISTRY.map((e) => `${e.method} ${e.path.split("?")[0]}`),
      ...MUTATION_REGISTRY.map((e) => `${e.method} ${e.path}`),
      ...Object.keys(OTHER_ROUTES),
    ]);
    const missing = routes.filter((r) => !r.isPublic && !r.isPlatform && !registered.has(`${r.method} ${r.path}`)).map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
    const known = new Set(routes.filter((r) => !r.isPlatform).map((r) => `${r.method} ${r.path}`));
    expect([...registered].filter((r) => !known.has(r))).toEqual([]); // 登记表里没有已不存在的接口
  });

  it("platform endpoints are unreachable from tenant hosts, and need a platform token on the platform host", async () => {
    const platformRoutes = listRoutes(CONTROLLERS).filter((r) => r.isPlatform);
    expect(platformRoutes.length).toBeGreaterThan(20);
    for (const r of platformRoutes) {
      const path = r.path.replace(/:\w+/g, "11111111-1111-4111-8111-111111111111");
      const verb = r.method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
      const call = (host: string, token: string | null) => {
        const req = request(app.getHttpServer())[verb](path).set("Host", host);
        return (token ? req.set("Authorization", `Bearer ${token}`) : req).send({});
      };
      expect({ at: `${r.method} ${r.path}: tenant token on tenant host`, status: (await call(a.host, a.token)).status }).toEqual({ at: `${r.method} ${r.path}: tenant token on tenant host`, status: 403 });
      expect({ at: `${r.method} ${r.path}: no token on tenant host`, status: (await call(a.host, null)).status }).toEqual({ at: `${r.method} ${r.path}: no token on tenant host`, status: 403 });
      expect({ at: `${r.method} ${r.path}: no token on platform host`, status: (await call("platform.localhost", null)).status }).toEqual({ at: `${r.method} ${r.path}: no token on platform host`, status: 401 });
      expect({ at: `${r.method} ${r.path}: tenant token on platform host`, status: (await call("platform.localhost", a.token)).status }).toEqual({ at: `${r.method} ${r.path}: tenant token on platform host`, status: 401 });
    }
  });

  it("the health check needs no token and no tenant", async () => {
    const res = await request(app.getHttpServer()).get("/healthz").set("Host", "localhost");
    expect(res.status).toBe(200);
  });

  describe.each(LEAK_REGISTRY)("$method $path ($kind)", (entry) => {
    it("returns the tenant's own data to its own user", async () => {
      const res = await get(a, pathFor(entry, a));
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body);
      for (const id of b.allIds) expect(text).not.toContain(id); // 一个 B 的 id 都不能出现
      if (entry.kind === "list") {
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.length).toBeGreaterThan(0);
        expect(res.body.every((row: { tenantId: string }) => row.tenantId === a.tenant.tenantId)).toBe(true);
      }
      if (entry.kind === "self") expect(res.body.id).toBe(a.aliceId);
    });

    it("rejects A's token on B's host, and B's token on A's host", async () => {
      expect((await get(b, pathFor(entry, b), { token: a.token })).status).toBe(401);
      expect((await get(a, pathFor(entry, a), { token: b.token })).status).toBe(401);
    });

    it("rejects requests without a token or with a garbage token", async () => {
      expect((await get(a, pathFor(entry, a), { token: null })).status).toBe(401);
      expect((await get(a, pathFor(entry, a), { token: "not.a.jwt" })).status).toBe(401);
    });

    it("ignores a tenant id sent by the client", async () => {
      const res = await get(a, pathFor(entry, a), {
        headers: { "x-tenant-id": b.tenant.tenantId, "x-tenant": b.tenant.code },
      });
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body);
      for (const id of b.allIds) expect(text).not.toContain(id);
    });

    it("is unavailable on the platform host and on unknown hosts", async () => {
      expect((await get(a, pathFor(entry, a), { host: "platform.localhost" })).status).toBe(403);
      expect((await get(a, pathFor(entry, a), { host: "no-such-tenant.localhost" })).status).toBe(404);
      expect((await get(a, pathFor(entry, a), { host: "localhost" })).status).toBe(404);
    });

    if (entry.kind === "detail") {
      it("returns 404 for another tenant's row, even with a valid token for this tenant", async () => {
        const foreignId = b.ids[entry.fixture!];
        const res = await get(a, entry.path.replace(":id", foreignId));
        expect(res.status).toBe(404);
      });
    }
  });

  it("a suspended tenant is refused, and works again when restored", async () => {
    await owner.tenant.update({ where: { id: a.tenant.tenantId }, data: { status: "suspended" } });
    try {
      expect((await get(a, "/api/campuses")).status).toBe(403);
    } finally {
      await owner.tenant.update({ where: { id: a.tenant.tenantId }, data: { status: "active" } });
    }
    expect((await get(a, "/api/campuses")).status).toBe(200);
  });

  it("a token for a deleted account is refused once permissions are reloaded", async () => {
    expect((await get(a, "/api/me")).status).toBe(200);
    await owner.account.update({ where: { id: a.aliceId }, data: { deletedAt: new Date() } });
    await redis.incr(`perm:v:${a.tenant.tenantId}`); // 真实流程里删账号会让权限版本号加一
    try {
      expect((await get(a, "/api/me")).status).toBe(401);
    } finally {
      await owner.account.update({ where: { id: a.aliceId }, data: { deletedAt: null } });
      await redis.incr(`perm:v:${a.tenant.tenantId}`);
    }
    expect((await get(a, "/api/me")).status).toBe(200);
  });

  describe("mutations aimed at another tenant", () => {
    const fill = (value: unknown): unknown =>
      JSON.parse(JSON.stringify(value).replace(/\{\{([AB])\.(\w+)\}\}/g, (_m, who: string, key: string) => (who === "A" ? a : b).ids[key as Fixture]));
    const fingerprint = async (side: Side) => {
      const out: Record<string, string | null> = {};
      for (const table of TABLES) {
        const rows = await owner.$queryRawUnsafe<Array<{ h: string | null }>>(
          `SELECT md5(string_agg(t::text, ',' ORDER BY t.id)) AS h FROM biz.${table} t WHERE t.tenant_id = '${side.tenant.tenantId}'`,
        );
        out[table] = rows[0].h;
      }
      return out;
    };

    it.each(MUTATION_REGISTRY.map((m) => [`${m.method} ${m.path} (${m.target}): ${m.note}`, m] as const))("%s", async (_name, m) => {
      const beforeA = await fingerprint(a);
      const beforeB = await fingerprint(b);
      const id = m.fixture ? (m.target === "foreign" ? b : a).ids[m.fixture] : "";
      const path = m.path.replace(/:(id|sid)/, id).replace(":code", "admin");
      const verb = m.method.toLowerCase() as "post" | "put" | "patch" | "delete";
      const res = await request(app.getHttpServer())[verb](path).set("Host", a.host).set("Authorization", `Bearer ${a.token}`).send((m.body === undefined ? undefined : fill(m.body)) as object);
      // 别人的行：404（不透露存在与否）；自己的行带着别人的关联 id：400
      expect(res.status).toBe(m.target === "foreign" ? 404 : 400);
      expect(await fingerprint(a)).toEqual(beforeA);
      expect(await fingerprint(b)).toEqual(beforeB);
    });
  });
});
