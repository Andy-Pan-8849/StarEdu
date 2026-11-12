import { SetMetadata } from "@nestjs/common";
import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

export const PLATFORM_ROUTE = "platformRoute";
/** 标记控制器/接口只属于平台入口（主机名 platform.*）；租户主机上访问一律拒绝，平台主机上只放行带这个标记的接口。 */
export const PlatformRoute = () => SetMetadata(PLATFORM_ROUTE, true);

export interface PlatformAuthContext {
  accountId: string;
  username: string;
  claims: Record<string, unknown>;
  sid: string | null;
  realm: string;
  perms: string[];
  isSuper: boolean;
}

export const PAuth = createParamDecorator((_d: unknown, ctx: ExecutionContext): PlatformAuthContext => ctx.switchToHttp().getRequest().platformAuth);
