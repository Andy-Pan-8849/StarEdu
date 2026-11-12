import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { TenantTokenGuard } from "./auth/tenant-token.guard";
import { HealthController } from "./health/health.controller";
import { HealthService } from "./health/health.service";
import { MeController } from "./me/me.controller";
import { OrgController } from "./org/org.controller";
import { PrismaService } from "./prisma/prisma.service";
import { RedisService } from "./redis/redis.service";
import { TenantPrismaService } from "./tenancy/tenant-prisma.service";
import { TenantResolverMiddleware } from "./tenancy/tenant-resolver.middleware";

@Module({
  controllers: [HealthController, MeController, OrgController],
  providers: [
    PrismaService,
    RedisService,
    HealthService,
    TenantPrismaService,
    { provide: APP_GUARD, useClass: TenantTokenGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // 健康检查不属于任何租户，其余所有路由先按主机名确定租户
    consumer.apply(TenantResolverMiddleware).exclude("healthz").forRoutes("*");
  }
}
