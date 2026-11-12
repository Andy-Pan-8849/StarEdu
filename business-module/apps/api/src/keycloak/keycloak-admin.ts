// Keycloak 管理接口的最小封装。脚本和"开通租户"服务共用。
export interface KeycloakEnv {
  url: string;
  adminUser: string;
  adminPassword: string;
}

export function keycloakEnv(env: NodeJS.ProcessEnv = process.env): KeycloakEnv {
  return {
    url: env.KEYCLOAK_URL ?? "http://localhost:8180",
    adminUser: env.KEYCLOAK_ADMIN ?? "admin",
    adminPassword: env.KEYCLOAK_ADMIN_PASSWORD ?? "admin",
  };
}

export interface UserProfileConfig {
  attributes: Array<{ name: string; required?: unknown; [key: string]: unknown }>;
  [key: string]: unknown;
}

export class KeycloakError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class KeycloakAdmin {
  private constructor(
    private readonly env: KeycloakEnv,
    private token: string,
  ) {}

  static async connect(env: KeycloakEnv = keycloakEnv()): Promise<KeycloakAdmin> {
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
    if (!res.ok) throw new KeycloakError(`Keycloak admin login failed: ${res.status}`, res.status);
    return new KeycloakAdmin(env, ((await res.json()) as { access_token: string }).access_token);
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
    if (!res.ok) throw new KeycloakError(`realm lookup failed: ${res.status}`, res.status);
    return true;
  }

  async createRealm(definition: Record<string, unknown>): Promise<void> {
    const res = await this.request("/realms", { method: "POST", body: JSON.stringify(definition) });
    if (res.status !== 201) throw new KeycloakError(`create realm failed: ${res.status} ${await res.text()}`, res.status);
  }

  async deleteRealm(realm: string): Promise<void> {
    const res = await this.request(`/realms/${realm}`, { method: "DELETE" });
    if (res.status !== 204 && res.status !== 404) throw new KeycloakError(`delete realm failed: ${res.status}`, res.status);
  }

  async getRealm(realm: string): Promise<Record<string, unknown>> {
    const res = await this.request(`/realms/${realm}`);
    if (!res.ok) throw new KeycloakError(`get realm failed: ${res.status}`, res.status);
    return (await res.json()) as Record<string, unknown>;
  }

  async getUserProfile(realm: string): Promise<UserProfileConfig> {
    const res = await this.request(`/realms/${realm}/users/profile`);
    if (!res.ok) throw new KeycloakError(`get user profile failed: ${res.status}`, res.status);
    return (await res.json()) as UserProfileConfig;
  }

  async setUserProfile(realm: string, profile: UserProfileConfig): Promise<void> {
    const res = await this.request(`/realms/${realm}/users/profile`, { method: "PUT", body: JSON.stringify(profile) });
    if (!res.ok) throw new KeycloakError(`set user profile failed: ${res.status} ${await res.text()}`, res.status);
  }

  /** 按用户名精确查找，找不到返回 null。 */
  async findUser(realm: string, username: string): Promise<{ id: string; username: string } | null> {
    const res = await this.request(`/realms/${realm}/users?username=${encodeURIComponent(username)}&exact=true`);
    if (!res.ok) throw new KeycloakError(`find user failed: ${res.status}`, res.status);
    const users = (await res.json()) as Array<{ id: string; username: string }>;
    return users[0] ?? null;
  }

  async createUser(
    realm: string,
    user: { username: string; email?: string; accountId: string; password?: string },
  ): Promise<string> {
    const res = await this.request(`/realms/${realm}/users`, {
      method: "POST",
      body: JSON.stringify({
        username: user.username,
        email: user.email,
        emailVerified: true,
        enabled: true,
        attributes: { account_id: [user.accountId] },
        credentials: user.password ? [{ type: "password", value: user.password, temporary: false }] : [],
      }),
    });
    if (res.status !== 201) throw new KeycloakError(`create user failed: ${res.status} ${await res.text()}`, res.status);
    const location = res.headers.get("location") ?? "";
    return location.substring(location.lastIndexOf("/") + 1);
  }

  /** 发"设置密码"邀请邮件（链接有效期取域设置里的管理员链接有效期）。 */
  async sendInvite(realm: string, userId: string, clientId: string, redirectUri: string): Promise<void> {
    const res = await this.request(
      `/realms/${realm}/users/${userId}/execute-actions-email?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      { method: "PUT", body: JSON.stringify(["UPDATE_PASSWORD"]) },
    );
    if (res.status !== 204) throw new KeycloakError(`send invite failed: ${res.status} ${await res.text()}`, res.status);
  }
}
