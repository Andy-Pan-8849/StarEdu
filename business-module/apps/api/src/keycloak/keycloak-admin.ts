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

  /** 按 id 取用户；不存在返回 null。 */
  async getUser(realm: string, userId: string): Promise<KeycloakUser | null> {
    const res = await this.request(`/realms/${realm}/users/${userId}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new KeycloakError(`get user failed: ${res.status}`, res.status);
    return (await res.json()) as KeycloakUser;
  }

  /** 列出域内全部用户（对账用，分页取完）。 */
  async listUsers(realm: string): Promise<KeycloakUser[]> {
    const out: KeycloakUser[] = [];
    const page = 100;
    for (let first = 0; ; first += page) {
      const res = await this.request(`/realms/${realm}/users?first=${first}&max=${page}&briefRepresentation=false`);
      if (!res.ok) throw new KeycloakError(`list users failed: ${res.status}`, res.status);
      const rows = (await res.json()) as KeycloakUser[];
      out.push(...rows);
      if (rows.length < page) return out;
    }
  }

  /** 推送账号资料：邮箱、启用状态（先读后改，保留 Keycloak 里的其他字段）。 */
  async updateUser(realm: string, userId: string, patch: { email?: string | null; enabled?: boolean }): Promise<void> {
    const current = await this.getUser(realm, userId);
    if (!current) throw new KeycloakError("user not found", 404);
    const body: KeycloakUser = { ...current };
    if (patch.email !== undefined) body.email = patch.email ?? undefined;
    if (patch.enabled !== undefined) body.enabled = patch.enabled;
    const res = await this.request(`/realms/${realm}/users/${userId}`, { method: "PUT", body: JSON.stringify(body) });
    if (res.status !== 204) throw new KeycloakError(`update user failed: ${res.status} ${await res.text()}`, res.status);
  }

  /** 解除登录失败造成的临时锁定。 */
  async unlockUser(realm: string, userId: string): Promise<void> {
    const res = await this.request(`/realms/${realm}/attack-detection/brute-force/users/${userId}`, { method: "DELETE" });
    if (res.status !== 204 && res.status !== 404) throw new KeycloakError(`unlock user failed: ${res.status}`, res.status);
  }

  /** 结束一个登录会话（强退时同时让刷新令牌失效）。会话已不存在也算成功。 */
  async deleteSession(realm: string, sessionId: string): Promise<void> {
    const res = await this.request(`/realms/${realm}/sessions/${sessionId}`, { method: "DELETE" });
    if (res.status !== 204 && res.status !== 404) throw new KeycloakError(`delete session failed: ${res.status}`, res.status);
  }
}

export interface KeycloakUser {
  id: string;
  username: string;
  email?: string;
  enabled?: boolean;
  attributes?: Record<string, string[]>;
  [key: string]: unknown;
}
