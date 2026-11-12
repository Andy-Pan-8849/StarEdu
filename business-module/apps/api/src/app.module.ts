import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import { HealthService } from "./health/health.service";
import { PrismaService } from "./prisma/prisma.service";
import { RedisService } from "./redis/redis.service";

@Module({
  controllers: [HealthController],
  providers: [PrismaService, RedisService, HealthService],
})
export class AppModule {}
