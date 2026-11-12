// Keycloak 管理接口的最小封装（脚本用；以后"新增租户"服务会把这些搬进 NestJS）。
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { UserProfileConfig } from "../../packages/shared/src/realm";

export function loadLocalEnv(): void {
  for (const name of [".env", ".env.example"]) {
    const file = resolve(__dirname, "../..", name);
    if (existsSync(file)) {
      process.loadEnvFile(file); // 已存在的环境变量不会被覆盖
      return;
    }
  }
}

export interface KeycloakEnv {
  url: string;
  adminUser: string;
  adminPassword: string;
}

export function keycloakEnv(): KeycloakEnv {
  return {
    url: process.env.KEYCLOAK_URL ?? "http://localhost:8180",
    adminUser: process.env.KEYCLOAK_ADMIN ?? "admin",
    adminPassword: process.env.KEYCLOAK_ADMIN_PASSWORD ?? "admin",
  };
}

export async function adminToken(env: KeycloakEnv): Promise<string> {
  const res = await fetch(`${env.url}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: env.adminUser,
      password: env.adminPassword,
    }),
  });
  if (!res.ok) throw new Error(`Keycloak admin login failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

export class KeycloakAdmin {
  constructor(
    private readonly env: KeycloakEnv,
    private token: string,
  ) {}

  static async connect(env: KeycloakEnv = keycloakEnv()): Promise<KeycloakAdmin> {
    return new KeycloakAdmin(env, await adminToken(env));
  }

  get url(): string {
    return this.env.url;
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.env.url}/admin${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  }

  async realmExists(realm: string): Promise<boolean> {
    const res = await this.request(`/realms/${realm}`);
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`realm lookup failed: ${res.status}`);
    return true;
  }

  async createRealm(definition: Record<string, unknown>): Promise<void> {
    const res = await this.request("/realms", { method: "POST", body: JSON.stringify(definition) });
    if (res.status !== 201) throw new Error(`create realm failed: ${res.status} ${await res.text()}`);
  }

  async deleteRealm(realm: string): Promise<void> {
    const res = await this.request(`/realms/${realm}`, { method: "DELETE" });
    if (res.status !== 204 && res.status !== 404) throw new Error(`delete realm failed: ${res.status}`);
  }

  async getUserProfile(realm: string): Promise<UserProfileConfig> {
    const res = await this.request(`/realms/${realm}/users/profile`);
    if (!res.ok) throw new Error(`get user profile failed: ${res.status}`);
    return (await res.json()) as UserProfileConfig;
  }

  async setUserProfile(realm: string, profile: UserProfileConfig): Promise<void> {
    const res = await this.request(`/realms/${realm}/users/profile`, { method: "PUT", body: JSON.stringify(profile) });
    if (!res.ok) throw new Error(`set user profile failed: ${res.status} ${await res.text()}`);
  }

  async getRealm(realm: string): Promise<Record<string, unknown>> {
    const res = await this.request(`/realms/${realm}`);
    if (!res.ok) throw new Error(`get realm failed: ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
}
