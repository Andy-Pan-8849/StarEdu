// 每个非公开接口的第一道关：认证（你是谁）+ 权限（你能做什么）。
//   1. 令牌：多签发者验证（签发者允许名单 → 取该域公钥 → 验签/iss/aud/exp）；
//   2. 令牌属于当前主机名对应的租户：签发域的租户代码、令牌里的 tenant_id 都要对得上；
//   3. 会话没有被强退（sid 拒绝名单）；
//   4. 账号在本租户存在、状态正常；
//   5. 接口声明的权限字符，账号必须全部具备；没有声明权限的接口一律拒绝（默认拒绝）。
// Redis 不可用时拒绝请求（503），不放行。
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { JWTPayload } from "jose";
import { AuthzService, type Authz } from "../rbac/authz.service";
import { currentScope } from "../tenancy/request-scope";
import { ANY_AUTHENTICATED, REQUIRED_PERMISSIONS } from "./decorators";
import { IS_PUBLIC } from "./public.decorator";
import { SessionStore } from "./session-store";
import { InvalidTokenError, TokenVerifier } from "./token-verifier";

export interface AuthContext {
  accountId: string;
  tenantId: string;
  claims: JWTPayload;
  /** Keycloak 登录会话 id（访问令牌里的 sid） */
  sid: string | null;
  realm: string;
  authz: Authz;
}

@Injectable()
export class TenantTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
    private readonly authzService: AuthzService,
    private readonly sessions: SessionStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const scope = currentScope();
    if (!scope || scope.kind !== "tenant") throw new ForbiddenException("This endpoint is for tenant hosts only");

    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new UnauthorizedException("Missing bearer token");

    let verified;
    try {
      verified = await this.verifier.verify(header.slice(7));
    } catch (err) {
      if (err instanceof InvalidTokenError) throw new UnauthorizedException("Invalid token");
      throw err;
    }
    const { claims } = verified;
    // 令牌必须是"当前访问的这个租户"的：A 域签发的令牌拿到 B 的网址上用，一律拒绝
    if (verified.kind !== "tenant" || verified.tenantCode !== scope.code || claims.tenant_id !== scope.tenantId) {
      throw new UnauthorizedException("Token is not valid for this tenant");
    }
    if (typeof claims.account_id !== "string") throw new UnauthorizedException("Token has no account");

    const sid = typeof claims.sid === "string" ? claims.sid : null;
    let authz: Authz | null;
    try {
      if (sid && (await this.sessions.isDenied(verified.realm, sid))) throw new UnauthorizedException("Session ended");
      authz = await this.authzService.load(scope.tenantId, claims.account_id);
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new ServiceUnavailableException("Authorization service unavailable");
    }
    if (!authz) throw new UnauthorizedException("Unknown account");
    if (authz.status === "disabled" || authz.status === "locked") throw new ForbiddenException("Account is not active");

    const required = this.reflector.getAllAndOverride<string[] | undefined>(REQUIRED_PERMISSIONS, targets);
    const anyAuth = this.reflector.getAllAndOverride<boolean | undefined>(ANY_AUTHENTICATED, targets) === true;
    // 待激活的账号（还没有登录过）只能走"任何已登录账号"的接口；登录登记接口会把它激活
    if (authz.status === "pending" && !anyAuth) throw new ForbiddenException("Account is not activated");
    if (!required && !anyAuth) throw new ForbiddenException("No permission declared for this endpoint");
    if (required) {
      const have = new Set(authz.perms);
      if (!required.every((p) => have.has(p))) throw new ForbiddenException("Missing permission");
    }

    req.auth = { accountId: authz.accountId, tenantId: scope.tenantId, claims, sid, realm: verified.realm, authz } satisfies AuthContext;
    if (sid) {
      this.sessions
        .touch(scope.tenantId, { sid, accountId: authz.accountId, username: authz.username, ip: req.ip, userAgent: req.headers["user-agent"] })
        .catch(() => undefined); // 在线状态只是展示用，写失败不影响请求
    }
    return true;
  }
}
