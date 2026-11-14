import { describe, expect, it } from "vitest";
import { adjustUserProfile, buildRealm, passwordPolicyString, realmName, DEFAULT_REALM_CONFIG, type RealmParams } from "./realm";

const base: RealmParams = {
  kind: "tenant",
  code: "hq",
  displayName: "StarIT",
  tenantId: "hq",
  webOrigin: "http://hq.localhost:3001",
  smtp: { host: "mailpit", port: 1025, from: "no-reply@staredu.test", fromDisplayName: "StarEdu" },
};

describe("passwordPolicyString", () => {
  it("encodes the decided policy (11 号文档 B3)", () => {
    expect(passwordPolicyString(DEFAULT_REALM_CONFIG.passwordPolicy)).toBe(
      "length(10) and upperCase(1) and lowerCase(1) and digits(1) and specialChars(1) and notUsername and notEmail and passwordHistory(2) and passwordBlacklist(common-weak.txt)",
    );
  });
});

describe("buildRealm", () => {
  it("names realms per tenant and one platform realm", () => {
    expect(realmName("tenant", "hq")).toBe("tenant-hq");
    expect(realmName("platform", "platform")).toBe("platform");
  });

  it("tenant realm has portal and admin clients with PKCE and no direct grant", () => {
    const realm = buildRealm(base) as { clients: Array<Record<string, any>> };
    expect(realm.clients.map((c) => c.clientId)).toEqual(["portal", "admin"]);
    for (const c of realm.clients) {
      expect(c.directAccessGrantsEnabled).toBe(false);
      expect(c.attributes["pkce.code.challenge.method"]).toBe("S256");
      expect(c.redirectUris[0].startsWith("http://hq.localhost:3001")).toBe(true);
    }
    expect(realm.clients[1].redirectUris[0]).toBe("http://hq.localhost:3001/admin/*");
  });

  it("platform realm has a single client", () => {
    const realm = buildRealm({ ...base, kind: "platform", code: "platform" }) as {
      realm: string;
      clients: Array<Record<string, any>>;
    };
    expect(realm.realm).toBe("platform");
    expect(realm.clients.map((c) => c.clientId)).toEqual(["platform"]);
  });

  it("puts only tenant_id and account_id (plus audience) in the token", () => {
    const realm = buildRealm(base) as { clients: Array<Record<string, any>> };
    const mappers = realm.clients[0].protocolMappers.map((m: any) => m.name);
    expect(mappers).toEqual(["tenant_id", "account_id", "api-audience"]);
    expect(realm.clients[0].protocolMappers[0].config["claim.value"]).toBe("hq");
  });

  it("applies lockout, token and link lifetimes from the config file", () => {
    const realm = buildRealm(base) as Record<string, any>;
    expect(realm.bruteForceProtected).toBe(true);
    expect(realm.permanentLockout).toBe(false);
    expect(realm.failureFactor).toBe(5);
    expect(realm.waitIncrementSeconds).toBe(600);
    expect(realm.maxFailureWaitSeconds).toBe(3600);
    expect(realm.accessTokenLifespan).toBe(900);
    expect(realm.actionTokenGeneratedByAdminLifespan).toBe(72 * 3600);
    expect(realm.actionTokenGeneratedByUserLifespan).toBe(30 * 60);
    expect(realm.registrationAllowed).toBe(false);
    expect(realm.duplicateEmailsAllowed).toBe(false);
  });

  it("only opens direct grant when explicitly asked (smoke test)", () => {
    const realm = buildRealm({ ...base, allowDirectGrant: true }) as { clients: Array<Record<string, any>> };
    expect(realm.clients[0].directAccessGrantsEnabled).toBe(true);
  });

  it("adds an AI assistant client to a company realm: its own origin, PKCE, and the AI audiences besides the business one", () => {
    const realm = buildRealm({ ...base, aiOrigin: "http://hq.localhost:3000" }) as { clients: Array<Record<string, any>> };
    const ai = realm.clients.find((c) => c.clientId === "ai")!;
    expect(ai).toBeTruthy();
    expect(ai.redirectUris).toEqual(["http://hq.localhost:3000/*"]);
    expect(ai.webOrigins).toEqual(["http://hq.localhost:3000"]);
    expect(ai.publicClient).toBe(true);
    expect(ai.attributes["pkce.code.challenge.method"]).toBe("S256");
    const audiences = ai.protocolMappers.filter((m: any) => m.protocolMapper === "oidc-audience-mapper").map((m: any) => m.config["included.custom.audience"]);
    expect(audiences.sort()).toEqual(["staredu-api", "starit-api", "starit-mcp"]);
    // 业务账号 id 和租户 id 仍在令牌里
    expect(ai.protocolMappers.map((m: any) => m.name)).toEqual(expect.arrayContaining(["tenant_id", "account_id"]));
    // 其他客户端没有 AI 的受众
    const portal = realm.clients.find((c) => c.clientId === "portal")!;
    expect(portal.protocolMappers.map((m: any) => m.config["included.custom.audience"])).not.toContain("starit-api");
  });

  it("has no AI client unless an AI origin is given, and never on the platform realm", () => {
    expect((buildRealm(base) as { clients: Array<Record<string, any>> }).clients.map((c) => c.clientId)).toEqual(["portal", "admin"]);
    const platform = buildRealm({ ...base, kind: "platform", code: "platform", aiOrigin: "http://x" }) as { clients: Array<Record<string, any>> };
    expect(platform.clients.map((c) => c.clientId)).toEqual(["platform"]);
  });

  it("points SMTP at the configured host", () => {
    const realm = buildRealm(base) as Record<string, any>;
    expect(realm.smtpServer.host).toBe("mailpit");
    expect(realm.smtpServer.port).toBe("1025");
  });
});

describe("adjustUserProfile", () => {
  const profile = {
    attributes: [
      { name: "username" },
      { name: "email", required: { roles: ["user"] } },
      { name: "firstName", required: { roles: ["user"] } },
      { name: "lastName", required: { roles: ["user"] } },
    ],
  };

  it("makes first and last name optional but keeps email as is", () => {
    const out = adjustUserProfile(profile);
    expect(out.attributes.find((a) => a.name === "firstName")?.required).toBeUndefined();
    expect(out.attributes.find((a) => a.name === "lastName")?.required).toBeUndefined();
    expect(out.attributes.find((a) => a.name === "email")?.required).toBeDefined();
  });

  it("declares account_id, admin-only, exactly once", () => {
    const once = adjustUserProfile(profile);
    const twice = adjustUserProfile(once);
    expect(twice.attributes.filter((a) => a.name === "account_id")).toHaveLength(1);
    const attr = once.attributes.find((a) => a.name === "account_id") as any;
    expect(attr.permissions).toEqual({ view: ["admin"], edit: ["admin"] });
  });
});
