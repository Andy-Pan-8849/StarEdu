import { Controller, Get, NotFoundException, Req } from "@nestjs/common";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import type { AuthContext } from "../auth/tenant-token.guard";

@Controller("api/me")
export class MeController {
  constructor(private readonly tenantDb: TenantPrismaService) {}

  @Get()
  async me(@Req() req: { auth: AuthContext }) {
    const account = await this.tenantDb.db.account.findUnique({ where: { id: req.auth.accountId } });
    if (!account) throw new NotFoundException("Account not found in this tenant");
    return { id: account.id, tenantId: account.tenantId, username: account.username, status: account.status };
  }
}
