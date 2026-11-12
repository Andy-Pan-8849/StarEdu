import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC = "isPublic";
/** 不需要令牌的接口（健康检查）。其余接口默认都要令牌。 */
export const Public = () => SetMetadata(IS_PUBLIC, true);
