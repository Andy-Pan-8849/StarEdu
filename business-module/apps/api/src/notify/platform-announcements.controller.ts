// 平台公告（横幅）：平台运营人员发布，租户的所有用户在有效期内能看到（经 /api/banners）。
import { Body, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { RequirePermissions } from "../auth/decorators";
import { parse } from "../common/http";
import { PAuth, PlatformRoute, type PlatformAuthContext } from "../platform/platform.decorators";
import { PlatformAuditService } from "../platform/platform-audit.service";
import { PlatformPrismaService } from "../platform/platform-prisma.service";

const schema = z
  .object({ title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(2000), severity: z.enum(["info", "warning"]).optional(), startsAt: z.string().datetime(), endsAt: z.string().datetime() })
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), { message: "endsAt must be after startsAt" });

@PlatformRoute()
@Controller("api/platform/announcements")
export class PlatformAnnouncementsController {
  constructor(
    private readonly db: PlatformPrismaService,
    private readonly audit: PlatformAuditService,
  ) {}

  @Get()
  @RequirePermissions(PERMS.platformAnnouncementList)
  list() {
    return this.db.platformAnnouncement.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  }

  @Post()
  @RequirePermissions(PERMS.platformAnnouncementEdit)
  async create(@PAuth() auth: PlatformAuthContext, @Body() body: unknown) {
    const input = parse(schema, body);
    const row = await this.db.platformAnnouncement.create({ data: { title: input.title, body: input.body, severity: input.severity ?? "info", startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt), createdBy: auth.accountId } });
    await this.audit.record(auth.accountId, "announcement.create", "announcement", row.id, { title: input.title });
    return row;
  }

  @Delete(":id")
  @RequirePermissions(PERMS.platformAnnouncementEdit)
  async remove(@PAuth() auth: PlatformAuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const { count } = await this.db.platformAnnouncement.deleteMany({ where: { id } });
    if (!count) throw new NotFoundException();
    await this.audit.record(auth.accountId, "announcement.delete", "announcement", id, {});
    return { id };
  }
}
