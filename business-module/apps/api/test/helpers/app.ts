// 端到端测试共用：完整的 Nest 应用 + 真实 Postgres/Redis/Keycloak，一个临时租户，若干带令牌的用户。
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import Redis from "ioredis";
import request from "supertest";
import { AppModule } from "../../src/app.module";
import type { KeycloakAdmin } from "../../src/keycloak/keycloak-admin";
import {
  connectKeycloak,
  createUser,
  giveRole,
  ownerClient,
  provisionTestTenant,
  removeTestTenant,
  type TestTenant,
} from "./fixtures";
import type { PrismaClient } from "../../src/generated/prisma";

export interface TestUser {
  accountId: string;
  personId: string | null;
  username: string;
  token: () => Promise<string>;
}

export class Harness {
  readonly owner: PrismaClient = ownerClient();
  readonly redis = new Redis(process.env.REDIS_URL as string);
  keycloak!: KeycloakAdmin;
  app!: INestApplication;
  tenant!: TestTenant;
  readonly extraTenants: TestTenant[] = [];

  get host(): string {
    return `${this.tenant.code}.localhost`;
  }
  get realm(): string {
    return `tenant-${this.tenant.code}`;
  }

  async start(): Promise<void> {
    this.keycloak = await connectKeycloak();
    this.tenant = await provisionTestTenant(this.owner, this.keycloak);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    this.app = moduleRef.createNestApplication();
    await this.app.init();
  }

  async stop(): Promise<void> {
    await this.app?.close();
    for (const t of [this.tenant, ...this.extraTenants]) if (t) await removeTestTenant(this.owner, this.keycloak, t.code);
    await this.owner.$disconnect();
    this.redis.disconnect();
  }

  async extraTenant(): Promise<TestTenant> {
    const t = await provisionTestTenant(this.owner, this.keycloak);
    this.extraTenants.push(t);
    return t;
  }

  /** 权限相关的数据被测试直接改了（绕过接口）时，模拟"权限版本号加一"。 */
  bump(tenantId = this.tenant.tenantId): Promise<number> {
    return this.redis.incr(`perm:v:${tenantId}`);
  }

  /**
   * 建一个用户：业务库账号 + Keycloak 用户（有密码，能换令牌）。
   * roles 是角色编码（tenant-admin / hr-manager / student ……）；person 给了就建人员并关联。
   */
  async user(
    username: string,
    opts: { roles?: string[]; person?: "staff" | "student"; tenant?: TestTenant; status?: "pending" | "active" | "disabled"; deptIds?: string[] } = {},
  ): Promise<TestUser> {
    const tenant = opts.tenant ?? this.tenant;
    const created = await createUser(this.owner, this.keycloak, tenant, username);
    let personId: string | null = null;
    if (opts.person) {
      const person = await this.owner.person.create({ data: { tenantId: tenant.tenantId, type: opts.person, fullName: username } });
      personId = person.id;
      if (opts.person === "staff") await this.owner.staffProfile.create({ data: { tenantId: tenant.tenantId, personId, employeeNo: `T-${username}`, hireDate: new Date("2020-01-01") } });
      await this.owner.account.update({ where: { id: created.accountId }, data: { personId } });
      for (const [i, deptId] of (opts.deptIds ?? []).entries()) {
        await this.owner.personDept.create({ data: { tenantId: tenant.tenantId, personId, deptId, isPrimary: i === 0 } });
      }
    }
    if (opts.status && opts.status !== "active") await this.owner.account.update({ where: { id: created.accountId }, data: { status: opts.status } });
    for (const code of opts.roles ?? []) await giveRole(this.owner, tenant.tenantId, created.accountId, code);
    await this.bump(tenant.tenantId);
    return { accountId: created.accountId, personId, username, token: created.token };
  }

  call(token: string | null, host = this.host) {
    const make = (method: "get" | "post" | "put" | "patch" | "delete") => (path: string, body?: unknown) => {
      const req = request(this.app.getHttpServer())[method](path).set("Host", host);
      if (token) req.set("Authorization", `Bearer ${token}`);
      return body === undefined ? req : req.send(body as object);
    };
    return { get: make("get"), post: make("post"), put: make("put"), patch: make("patch"), del: make("delete") };
  }
}

export function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}
