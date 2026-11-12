// 平台入口专用的数据库客户端：用库所有者账号连接，绕过行级安全。
// 只在平台域的请求里使用（主机名 platform.*、平台域令牌，守卫已验证）；租户的请求用 biz_app 连接，
// 碰不到平台表（权限已回收，schema 测试验证）。
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "../generated/prisma";
import { loadConfig } from "../config/config";

@Injectable()
export class PlatformPrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    const config = loadConfig();
    const url = config.PLATFORM_DATABASE_URL ?? config.MIGRATION_DATABASE_URL;
    super(url ? { datasourceUrl: url } : undefined);
  }
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
