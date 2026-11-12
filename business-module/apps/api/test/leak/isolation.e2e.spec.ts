// 跨租户泄露扫描（端到端：真实 Postgres + 真实 Keycloak 令牌 + 完整的 Nest 应用）。
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../src/app.module";
import { HealthController } from "../../src/health/health.controller";
import { MeController } from "../../src/me/me.controller";
import { OrgController } from "../../src/org/org.controller";
import type { KeycloakAdmin } from "../../src/keycloak/keycloak-admin";
import {
  connectKeycloak,
  createUser,
  ownerClient,
  provisionTestTenant,
  removeTestTenant,
  type TestTenant,
} from "../helpers/fixtures";
import { LEAK_REGISTRY } from "./registry";
import { listRoutes } from "./routes";

interface Side {
  tenant: TestTenant;
  host: string;
  token: string;
  accountId: string;
  ids: { campusId: string; deptId: string; postId: string };
  allIds: Set<string>;
}

describe("cross-tenant leak scan", () => {
  const owner = ownerClient();
  let keycloak: KeycloakAdmin;
  let app: INestApplication;
  let a: Side;
  let b: Side;

  async function build(): Promise<Side> {
    const tenant = await provisionTestTenant(owner, keycloak);
    const user = await createUser(owner, keycloak, tenant, "alice");
    const campus = await owner.campus.findFirstOrThrow({ where: { tenantId: tenant.tenantId } });
    const dept = await owner.dept.create({ data: { tenantId: tenant.tenantId, name: "Dept", parentId: campus.deptId } });
    const post = await owner.post.create({ data: { tenantId: tenant.tenantId, code: "teacher", name: "Teacher" } });
    const extraCampusDept = await owner.dept.create({ data: { tenantId: tenant.tenantId, name: "Second campus" } });
    const extraCampus = await owner.campus.create({
      data: { tenantId: tenant.tenantId, deptId: extraCampusDept.id, code: "SH", name: "Second", timezone: "UTC" },
    });
    return {
      tenant,
      host: `${tenant.code}.localhost`,
      token: await user.token(),
      accountId: user.accountId,
      ids: { campusId: campus.id, deptId: dept.id, postId: post.id },
      allIds: new Set([tenant.tenantId, campus.id, campus.deptId, dept.id, post.id, extraCampus.id, extraCampusDept.id, user.accountId]),
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
  });

  const get = (side: Side, path: string, opts: { host?: string; token?: string | null; headers?: Record<string, string> } = {}) => {
    const req = request(app.getHttpServer()).get(path).set("Host", opts.host ?? side.host);
    const token = opts.token === undefined ? side.token : opts.token;
    if (token) req.set("Authorization", `Bearer ${token}`);
    for (const [k, v] of Object.entries(opts.headers ?? {})) req.set(k, v);
    return req;
  };
  const pathFor = (entry: (typeof LEAK_REGISTRY)[number], side: Side) =>
    entry.fixture ? entry.path.replace(":id", side.ids[entry.fixture]) : entry.path;

  it("every route is either public or registered in the leak registry", () => {
    const routes = listRoutes([HealthController, MeController, OrgController]);
    const registered = new Set(LEAK_REGISTRY.map((e) => `${e.method} ${e.path}`));
    const missing = routes.filter((r) => !r.isPublic && !registered.has(`${r.method} ${r.path}`)).map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
    const known = new Set(routes.map((r) => `${r.method} ${r.path}`));
    expect([...registered].filter((r) => !known.has(r))).toEqual([]); // 登记表里没有已不存在的接口
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
      if (entry.kind === "self") expect(res.body.id).toBe(a.accountId);
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

  it("a token for a deleted account finds nothing in /api/me", async () => {
    await owner.account.update({ where: { id: a.accountId }, data: { deletedAt: new Date() } });
    try {
      expect((await get(a, "/api/me")).status).toBe(404);
    } finally {
      await owner.account.update({ where: { id: a.accountId }, data: { deletedAt: null } });
    }
  });
});
