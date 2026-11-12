// 接口的权限声明。非公开接口必须声明其一，否则一律拒绝（默认拒绝，宁可漏放不可漏拦）。
import { SetMetadata } from "@nestjs/common";

export const REQUIRED_PERMISSIONS = "requiredPermissions";
export const ANY_AUTHENTICATED = "anyAuthenticated";

/** 需要同时具备这些权限字符（`模块:资源:动作`）。 */
export const RequirePermissions = (...perms: string[]) => SetMetadata(REQUIRED_PERMISSIONS, perms);

/** 任何已登录的本租户账号都可以访问（如"我自己的信息"）。要谨慎使用。 */
export const AnyAuthenticated = () => SetMetadata(ANY_AUTHENTICATED, true);
