// 我的消息：消息中心（读取、标已读、断线后补拉）、通知偏好、WebSocket 票据、平台横幅、退订链接。
// 同一套接口挂在管理后台（/api/notifications）和学生门户（/api/portal/notifications）两个前缀下；
// 一切只针对"我自己"的账号：看不到也改不了别人的。
import { BadRequestException, Body, Controller, Get, Headers, Put, Post, Query, Res } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type { Response } from "express";
import { z } from "zod";
import { AnyAuthenticated } from "../auth/decorators";
import { Public } from "../auth/public.decorator";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { PlatformPrismaService } from "../platform/platform-prisma.service";
import { RedisService } from "../redis/redis.service";
import { currentScope } from "../tenancy/request-scope";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { readUnsubscribe } from "./notification.service";
import { TICKET_TTL_SECONDS } from "./realtime.service";
import { CATEGORIES, pickLocale, render } from "./templates";

const readSchema = z.object({ ids: z.array(z.string().uuid()).max(200).optional(), all: z.boolean().optional() });
const prefsSchema = z.object({
  locale: z.enum(["en", "zh"]).nullable().optional(),
  prefs: z.array(z.object({ category: z.enum(CATEGORIES), inApp: z.boolean(), email: z.boolean() })).max(CATEGORIES.length).optional(),
});

@Controller(["api/notifications", "api/portal/notifications"])
export class NotificationsController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly redis: RedisService,
  ) {}

  private get db() {
    return this.tenantDb.db;
  }

  /** 消息中心：最新在前。after（ISO 时间）只要比它新的——断线重连后用它补拉；unread=1 只看未读。 */
  @Get()
  @AnyAuthenticated()
  async list(@Auth() auth: AuthContext, @Headers("accept-language") lang: string | undefined, @Query() q: { after?: string; unread?: string; size?: string }) {
    const account = await this.db.account.findUnique({ where: { id: auth.accountId }, select: { locale: true } });
    const locale = pickLocale(account?.locale, lang);
    const after = q.after ? new Date(q.after) : null;
    if (after && Number.isNaN(after.getTime())) throw new BadRequestException("after must be a date");
    const size = Math.min(100, Math.max(1, Number.parseInt(q.size ?? "30", 10) || 30));
    const where = { accountId: auth.accountId, inApp: true, ...(after ? { createdAt: { gt: after } } : {}), ...(q.unread === "1" ? { readAt: null } : {}) };
    const [rows, unread] = await Promise.all([this.db.notification.findMany({ where, orderBy: { createdAt: "desc" }, take: size }), this.db.notification.count({ where: { accountId: auth.accountId, inApp: true, readAt: null } })]);
    return {
      unread,
      items: rows.map((n) => {
        const text = n.type === "announcement" ? { title: n.title ?? "", body: n.body ?? "" } : render(n.type, n.params as Record<string, unknown>, locale);
        return { id: n.id, category: n.category, type: n.type, title: text.title, body: text.body, createdAt: n.createdAt, readAt: n.readAt };
      }),
    };
  }

  @Post("read")
  @AnyAuthenticated()
  async markRead(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(readSchema, body);
    if (!input.all && !input.ids?.length) throw new BadRequestException("Give ids or all");
    const { count } = await this.db.notification.updateMany({ where: { accountId: auth.accountId, readAt: null, ...(input.all ? {} : { id: { in: input.ids } }) }, data: { readAt: new Date() } });
    return { marked: count };
  }

  /** 实时推送的一次性票据：30 秒有效，连接时取一次就删。 */
  @Post("ws-ticket")
  @AnyAuthenticated()
  async ticket(@Auth() auth: AuthContext) {
    const ticket = randomBytes(24).toString("hex");
    await this.redis.client.set(`ws:ticket:${ticket}`, JSON.stringify({ tenantId: auth.tenantId, accountId: auth.accountId }), "EX", TICKET_TTL_SECONDS);
    return { ticket, expiresInSeconds: TICKET_TTL_SECONDS, path: "/ws" };
  }

  @Get("preferences")
  @AnyAuthenticated()
  async preferences(@Auth() auth: AuthContext) {
    const [account, rows] = await Promise.all([this.db.account.findUnique({ where: { id: auth.accountId }, select: { locale: true } }), this.db.notificationPreference.findMany({ where: { accountId: auth.accountId } })]);
    return { locale: account?.locale ?? null, categories: CATEGORIES.map((c) => ({ category: c, inApp: rows.find((r) => r.category === c)?.inApp ?? true, email: rows.find((r) => r.category === c)?.email ?? true })) };
  }

  @Put("preferences")
  @AnyAuthenticated()
  async setPreferences(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(prefsSchema, body);
    await this.tenantDb.transaction(async (tx) => {
      if (input.locale !== undefined) await tx.account.update({ where: { id: auth.accountId }, data: { locale: input.locale } });
      for (const p of input.prefs ?? []) {
        await tx.notificationPreference.upsert({
          where: { accountId_category: { accountId: auth.accountId, category: p.category } },
          create: { tenantId: auth.tenantId, accountId: auth.accountId, category: p.category, inApp: p.inApp, email: p.email },
          update: { inApp: p.inApp, email: p.email },
        });
      }
    });
    return this.preferences(auth);
  }
}

/** 当前有效的平台公告（横幅）：平台表，租户用户只能经这里读。 */
@Controller(["api/banners", "api/portal/banners"])
export class BannersController {
  constructor(private readonly platformDb: PlatformPrismaService) {}

  @Get()
  @AnyAuthenticated()
  async banners() {
    const now = new Date();
    const rows = await this.platformDb.platformAnnouncement.findMany({ where: { startsAt: { lte: now }, endsAt: { gt: now } }, orderBy: { startsAt: "desc" }, take: 5 });
    return rows.map((r) => ({ id: r.id, title: r.title, body: r.body, severity: r.severity, endsAt: r.endsAt }));
  }
}

/** 邮件里的退订链接：不用登录，凭签名的令牌关掉这个类别的邮件（可重复点击，结果相同）。 */
@Controller("api/unsubscribe")
export class UnsubscribeController {
  constructor(private readonly platformDb: PlatformPrismaService) {}

  @Get()
  @Public()
  async unsubscribe(@Query("token") token: string | undefined, @Res() res: Response) {
    const claims = token ? readUnsubscribe(token) : null;
    const scope = currentScope();
    // 令牌必须是这个租户的（主机名对应的租户）签发的
    if (!claims || !scope || scope.kind !== "tenant" || scope.tenantId !== claims.tenantId) {
      res.status(400).type("html").send("<p>This unsubscribe link is not valid.</p>");
      return;
    }
    await this.platformDb.notificationPreference.upsert({
      where: { accountId_category: { accountId: claims.accountId, category: claims.category } },
      create: { tenantId: claims.tenantId, accountId: claims.accountId, category: claims.category, inApp: true, email: false },
      update: { email: false },
    });
    res.type("html").send(`<p>You will no longer get "${claims.category}" e-mails. You can change this in your notification settings.</p>`);
  }
}
