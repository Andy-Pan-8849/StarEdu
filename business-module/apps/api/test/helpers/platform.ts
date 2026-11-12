// 平台入口的端到端测试夹具：平台域（Keycloak 的 platform 域，没有就按模板建，并打开密码直连授权）、
// 平台账号（业务库 + Keycloak 用户），用完清理。
import Redis from "ioredis";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { PASSWORD } from "./fixtures";
import { syncPlatformMenus } from "../../src/catalog/menu-sync";
import type { KeycloakAdmin } from "../../src/keycloak/keycloak-admin";
import { createRealm, smtpFromEnv, tenantOrigin } from "../../src/keycloak/realm-provisioner";
import type { PrismaClient } from "../../src/generated/prisma";

export const PLATFORM_HOST = "platform.localhost";

export interface PlatformUser {
  accountId: string;
  username: string;
  token: () => Promise<string>;
}

export class PlatformFixture {
  private readonly created: string[] = [];
  private readonly createdRoles: string[] = [];
  private readonly redis = new Redis(process.env.REDIS_URL as string);

  constructor(
    private readonly owner: PrismaClient,
    private readonly keycloak: KeycloakAdmin,
  ) {}

  async setup(): Promise<void> {
    await syncPlatformMenus(this.owner);
    if (!(await this.keycloak.realmExists("platform"))) {
      await createRealm(this.keycloak, { kind: "platform", code: "platform", name: "StarEdu Platform", tenantId: "platform", webOrigin: tenantOrigin("platform"), smtp: smtpFromEnv(), allowDirectGrant: true });
    }
    // 已存在的平台域（本机 pnpm realm 建的）没开密码直连：测试里打开（只影响本机测试环境）
    const clients = (await (await this.keycloak.request("/realms/platform/clients?clientId=platform")).json()) as Array<{ id: string; directAccessGrantsEnabled: boolean }>;
    if (clients[0] && !clients[0].directAccessGrantsEnabled) {
      await this.keycloak.request(`/realms/platform/clients/${clients[0].id}`, { method: "PUT", body: JSON.stringify({ ...clients[0], directAccessGrantsEnabled: true }) });
    }
  }

  bump(): Promise<number> {
    return this.redis.incr("perm:v:platform");
  }

  /** roles：平台角色编码（platform-super 或自己建的）。 */
  async user(username: string, opts: { roles?: string[]; status?: "pending" | "active" | "disabled" } = {}): Promise<PlatformUser> {
    const account = await this.owner.platformAccount.create({ data: { username, email: `${username}@platform.example.test`, status: opts.status ?? "active" } });
    this.created.push(account.id);
    const kcId = await this.keycloak.createUser("platform", { username, email: account.email ?? undefined, accountId: account.id, password: PASSWORD });
    await this.owner.platformAccount.update({ where: { id: account.id }, data: { keycloakUserId: kcId } });
    for (const code of opts.roles ?? []) {
      const role = await this.owner.platformRole.findFirstOrThrow({ where: { code } });
      await this.owner.platformAccountRole.create({ data: { accountId: account.id, roleId: role.id } });
    }
    await this.bump();
    return {
      accountId: account.id,
      username,
      token: async () => {
        const res = await fetch(`${this.keycloak.url}/realms/platform/protocol/openid-connect/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "password", client_id: "platform", username, password: PASSWORD }),
        });
        if (!res.ok) throw new Error(`platform login failed: ${res.status} ${await res.text()}`);
        return ((await res.json()) as { access_token: string }).access_token;
      },
    };
  }

  trackRole(id: string): void {
    this.createdRoles.push(id);
  }

  async cleanup(): Promise<void> {
    for (const id of this.created) {
      const a = await this.owner.platformAccount.findUnique({ where: { id } });
      await this.owner.platformAccountRole.deleteMany({ where: { accountId: id } });
      await this.owner.platformAccount.deleteMany({ where: { id } });
      if (a?.keycloakUserId) await this.keycloak.request(`/realms/platform/users/${a.keycloakUserId}`, { method: "DELETE" });
    }
    for (const id of this.createdRoles) {
      await this.owner.platformRoleMenu.deleteMany({ where: { roleId: id } });
      await this.owner.platformAccountRole.deleteMany({ where: { roleId: id } });
      await this.owner.platformRole.deleteMany({ where: { id } });
    }
    this.redis.disconnect();
  }
}

export function platformCall(app: INestApplication, token: string | null, host = PLATFORM_HOST) {
  const make = (method: "get" | "post" | "put" | "patch" | "delete") => (path: string, body?: unknown) => {
    const req = request(app.getHttpServer())[method](path).set("Host", host);
    if (token) req.set("Authorization", `Bearer ${token}`);
    return body === undefined ? req : req.send(body as object);
  };
  return { get: make("get"), post: make("post"), put: make("put"), patch: make("patch"), del: make("delete") };
}
