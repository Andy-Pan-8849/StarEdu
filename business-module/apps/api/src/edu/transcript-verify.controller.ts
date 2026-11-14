// 成绩单公开验真（不登录）：扫成绩单上的二维码，打开 租户网址/verify/<令牌>，页面调这里。
// 令牌 144 位随机、不可猜；返回的只有生成当时的要点（姓名、遮住的学号、专业、累计 GPA 和学分、状态、指纹），
// 没有逐门课成绩。租户由主机名决定，别的租户的令牌在这里查不到。按来源地址限速，防止有人批量试令牌。
import { Controller, Get, HttpException, HttpStatus, NotFoundException, Param, Req } from "@nestjs/common";
import type { Request } from "express";
import { Public } from "../auth/public.decorator";
import { RedisService } from "../redis/redis.service";
import { requireTenant } from "../tenancy/request-scope";
import { TranscriptService } from "./transcript.service";

export const VERIFY_LIMIT_PER_MINUTE = 30;

@Controller("api/public/transcripts")
export class TranscriptVerifyController {
  constructor(private readonly transcripts: TranscriptService, private readonly redis: RedisService) {}

  @Get(":token")
  @Public()
  async verify(@Param("token") token: string, @Req() req: Request) {
    const tenant = requireTenant("verify transcript");
    const key = `verify:rl:${tenant.tenantId}:${req.ip ?? "?"}:${Math.floor(Date.now() / 60000)}`;
    const n = await this.redis.client.incr(key);
    if (n === 1) await this.redis.client.expire(key, 120);
    if (n > VERIFY_LIMIT_PER_MINUTE) throw new HttpException("Too many requests", HttpStatus.TOO_MANY_REQUESTS);
    if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) throw new NotFoundException();
    const result = await this.transcripts.verify(token);
    if (!result) throw new NotFoundException();
    return result;
  }
}
