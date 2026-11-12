import { BadRequestException, createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { z } from "zod";
import type { AuthContext } from "../auth/tenant-token.guard";

/** 当前请求的认证信息（守卫已验证并加载好权限）。 */
export const Auth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => ctx.switchToHttp().getRequest().auth);

/** 请求的客户端信息，用于日志。 */
export const ClientInfo = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest();
  return { ip: req.ip as string | undefined, userAgent: req.headers["user-agent"] as string | undefined };
});

export function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  }
  return result.data;
}

/** 分页参数：page 从 1 开始，size 默认 20、最大 100。 */
export function paging(query: { page?: string; size?: string }): { skip: number; take: number } {
  const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
  const size = Math.min(100, Math.max(1, Number.parseInt(query.size ?? "20", 10) || 20));
  return { skip: (page - 1) * size, take: size };
}
