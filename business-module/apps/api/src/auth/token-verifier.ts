// 多签发者令牌验证：
//   令牌的 iss → 允许名单（只认本 Keycloak 下"已开通租户的域"和平台域）→ 取该域的公钥（带缓存）
//   → 验签、iss、aud、exp。主机名与令牌是否匹配由守卫判断（这里不管主机）。
import { Injectable } from "@nestjs/common";
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from "jose";
import { DEFAULT_REALM_CONFIG, realmName } from "@staredu/shared";
import { loadConfig } from "../config/config";
import { PrismaService } from "../prisma/prisma.service";

export class InvalidTokenError extends Error {}

export interface VerifiedToken {
  claims: JWTPayload;
  realm: string;
  /** 租户域的租户代码；平台域为 null */
  tenantCode: string | null;
  kind: "tenant" | "platform";
}

const TENANT_REALM_PREFIX = "tenant-";
const KNOWN_TTL_MS = 30_000;

@Injectable()
export class TokenVerifier {
  private readonly keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
  private readonly known = new Map<string, { ok: boolean; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  async verify(token: string): Promise<VerifiedToken> {
    const config = loadConfig();
    let issuer: string;
    try {
      const iss = decodeJwt(token).iss;
      if (typeof iss !== "string") throw new Error("no iss");
      issuer = iss;
    } catch {
      throw new InvalidTokenError("Malformed token");
    }
    const issuerBase = config.KEYCLOAK_ISSUER_BASE ?? config.KEYCLOAK_URL;
    const prefix = `${issuerBase}/realms/`;
    if (!issuer.startsWith(prefix)) throw new InvalidTokenError("Unknown issuer");
    const realm = issuer.slice(prefix.length);

    let kind: "tenant" | "platform";
    let tenantCode: string | null = null;
    if (realm === realmName("platform", "")) {
      kind = "platform";
    } else if (realm.startsWith(TENANT_REALM_PREFIX) && realm.length > TENANT_REALM_PREFIX.length) {
      kind = "tenant";
      tenantCode = realm.slice(TENANT_REALM_PREFIX.length);
      if (!(await this.isKnownTenant(tenantCode))) throw new InvalidTokenError("Unknown issuer");
    } else {
      throw new InvalidTokenError("Unknown issuer");
    }

    try {
      const { payload } = await jwtVerify(token, this.keySetFor(`${config.KEYCLOAK_URL}/realms/${realm}/protocol/openid-connect/certs`), {
        issuer,
        audience: DEFAULT_REALM_CONFIG.audience,
      });
      return { claims: payload, realm, tenantCode, kind };
    } catch {
      throw new InvalidTokenError("Invalid token");
    }
  }

  /** 允许名单：已开通（库里有记录）的租户的域。结果缓存很短时间，避免每个请求都查库。 */
  private async isKnownTenant(code: string): Promise<boolean> {
    const hit = this.known.get(code);
    if (hit && Date.now() - hit.at < KNOWN_TTL_MS) return hit.ok;
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM biz.resolve_tenant(${code})`;
    const ok = rows.length > 0;
    this.known.set(code, { ok, at: Date.now() });
    return ok;
  }

  private keySetFor(url: string) {
    let set = this.keySets.get(url);
    if (!set) {
      // jose 缓存公钥；遇到没见过的 kid 才重新拉取（有冷却时间，防止被乱填 kid 打爆 Keycloak）
      set = createRemoteJWKSet(new URL(url), { cooldownDuration: 10_000, cacheMaxAge: 10 * 60_000 });
      this.keySets.set(url, set);
    }
    return set;
  }
}
