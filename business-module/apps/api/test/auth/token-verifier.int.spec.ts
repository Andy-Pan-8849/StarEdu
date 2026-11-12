// 多签发者令牌验证的各种坏令牌：未知签发者、签名错、受众错、过期、没有签发者、不签名的令牌……
// 用本机的一个假 JWKS 服务器和自己的密钥签发令牌（Keycloak 不会签发过期或错误受众的令牌），
// 租户允许名单用真实的 Postgres（biz.resolve_tenant）。
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { PrismaService } from "../../src/prisma/prisma.service";
import { InvalidTokenError, TokenVerifier } from "../../src/auth/token-verifier";
import { connectKeycloak, ownerClient, provisionTestTenant, removeTestTenant, type TestTenant } from "../helpers/fixtures";
import type { KeycloakAdmin } from "../../src/keycloak/keycloak-admin";

describe("TokenVerifier", () => {
  const owner = ownerClient();
  let keycloak: KeycloakAdmin;
  let tenant: TestTenant;
  let server: Server;
  let base: string;
  let good: Awaited<ReturnType<typeof generateKeyPair>>;
  let other: Awaited<ReturnType<typeof generateKeyPair>>;
  let verifier: TokenVerifier;
  const saved = { url: process.env.KEYCLOAK_URL, issuer: process.env.KEYCLOAK_ISSUER_BASE };

  beforeAll(async () => {
    keycloak = await connectKeycloak();
    tenant = await provisionTestTenant(owner, keycloak);
    good = await generateKeyPair("RS256");
    other = await generateKeyPair("RS256");
    const jwk: JWK = { ...(await exportJWK(good.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    server = createServer((req, res) => {
      if (req.url?.endsWith("/protocol/openid-connect/certs")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ keys: [jwk] }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.KEYCLOAK_URL = base;
    delete process.env.KEYCLOAK_ISSUER_BASE;
    verifier = new TokenVerifier(new PrismaService());
  });
  afterAll(async () => {
    server.close();
    process.env.KEYCLOAK_URL = saved.url;
    if (saved.issuer !== undefined) process.env.KEYCLOAK_ISSUER_BASE = saved.issuer;
    await removeTestTenant(owner, keycloak, tenant.code);
    await owner.$disconnect();
  });

  const sign = (opts: { realm?: string; iss?: string; aud?: string; exp?: string | number; key?: typeof good; kid?: string; claims?: Record<string, unknown> } = {}) =>
    new SignJWT({ tenant_id: tenant.tenantId, account_id: "acct", ...(opts.claims ?? {}) })
      .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? "k1" })
      .setIssuer(opts.iss ?? `${base}/realms/${opts.realm ?? `tenant-${tenant.code}`}`)
      .setAudience(opts.aud ?? "staredu-api")
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "5m")
      .sign((opts.key ?? good).privateKey);

  it("accepts a well-formed token from a known tenant realm", async () => {
    const v = await verifier.verify(await sign());
    expect(v).toMatchObject({ kind: "tenant", tenantCode: tenant.code, realm: `tenant-${tenant.code}` });
    expect(v.claims.tenant_id).toBe(tenant.tenantId);
  });

  it("accepts a token from the platform realm and says so (the guard decides where it is allowed)", async () => {
    expect(await verifier.verify(await sign({ realm: "platform" }))).toMatchObject({ kind: "platform", tenantCode: null });
  });

  it.each([
    ["an unknown tenant's realm", () => sign({ realm: "tenant-no-such-tenant" })],
    ["the master realm", () => sign({ realm: "master" })],
    ["a different Keycloak (issuer base)", () => sign({ iss: `https://evil.example/realms/tenant-${tenant.code}` })],
    ["an issuer without a realm", () => sign({ iss: base })],
    ["the wrong audience", () => sign({ aud: "some-other-api" })],
    ["an expired token", () => sign({ exp: Math.floor(Date.now() / 1000) - 60 })],
    ["a signature made with another key", () => sign({ key: other })],
    ["a key id the realm does not publish", () => sign({ kid: "unknown-kid" })],
  ])("rejects %s", async (_name, make) => {
    await expect(verifier.verify(await make())).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rejects tokens that are unsigned, malformed or have no issuer", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ iss: `${base}/realms/tenant-${tenant.code}`, aud: "staredu-api", exp: 9999999999 })).toString("base64url");
    await expect(verifier.verify(`${header}.${body}.`)).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(verifier.verify("not.a.jwt")).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(verifier.verify("")).rejects.toBeInstanceOf(InvalidTokenError);
    const noIss = await new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "k1" }).setAudience("staredu-api").setExpirationTime("5m").sign(good.privateKey);
    await expect(verifier.verify(noIss)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("a HS256 token signed with the public key as a secret is rejected (algorithm confusion)", async () => {
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setIssuer(`${base}/realms/tenant-${tenant.code}`)
      .setAudience("staredu-api")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(JSON.stringify(await exportJWK(good.publicKey))));
    await expect(verifier.verify(forged)).rejects.toBeInstanceOf(InvalidTokenError);
  });
});
