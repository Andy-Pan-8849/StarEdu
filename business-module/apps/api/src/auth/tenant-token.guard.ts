// B1 的最小令牌校验：令牌必须是"当前访问的这个租户的域"签发的。
//   - 签发者必须等于该租户域；A 域签发的令牌拿到 B 租户的网址上用，签发者对不上，直接拒绝；
//   - 签名用该域的公钥校验，受众必须是 staredu-api，未过期；
//   - 令牌里的 tenant_id 必须等于主机名对应的租户。
// B2 在此基础上做成"多签发者允许名单 + 公钥缓存 + sid 拒绝名单 + 权限校验"。
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { DEFAULT_REALM_CONFIG, realmName } from "@staredu/shared";
import { loadConfig } from "../config/config";
import { currentScope } from "../tenancy/request-scope";
import { IS_PUBLIC } from "./public.decorator";

export interface AuthContext {
  accountId: string;
  tenantId: string;
  claims: JWTPayload;
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keySetFor(jwksUrl: string) {
  let set = keySets.get(jwksUrl);
  if (!set) {
    set = createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 10_000 });
    keySets.set(jwksUrl, set);
  }
  return set;
}

@Injectable()
export class TenantTokenGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;

    const scope = currentScope();
    if (!scope || scope.kind !== "tenant") throw new ForbiddenException("This endpoint is for tenant hosts only");

    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new UnauthorizedException("Missing bearer token");

    const config = loadConfig();
    const realm = realmName("tenant", scope.code);
    const issuer = `${config.KEYCLOAK_ISSUER_BASE ?? config.KEYCLOAK_URL}/realms/${realm}`;
    const jwksUrl = `${config.KEYCLOAK_URL}/realms/${realm}/protocol/openid-connect/certs`;

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(header.slice(7), keySetFor(jwksUrl), {
        issuer,
        audience: DEFAULT_REALM_CONFIG.audience,
      }));
    } catch {
      throw new UnauthorizedException("Invalid token");
    }
    if (payload.tenant_id !== scope.tenantId) throw new ForbiddenException("Token belongs to another tenant");
    if (typeof payload.account_id !== "string") throw new UnauthorizedException("Token has no account");

    req.auth = { accountId: payload.account_id, tenantId: scope.tenantId, claims: payload } satisfies AuthContext;
    return true;
  }
}
