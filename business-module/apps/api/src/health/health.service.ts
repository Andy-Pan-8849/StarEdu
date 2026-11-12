import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";

export interface HealthReport {
  status: "ok" | "degraded";
  checks: { database: "up" | "down"; redis: "up" | "down" };
}

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async check(): Promise<HealthReport> {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    return { status: database === "up" && redis === "up" ? "ok" : "degraded", checks: { database, redis } };
  }

  private async checkDatabase(): Promise<"up" | "down"> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return "up";
    } catch {
      return "down";
    }
  }

  private async checkRedis(): Promise<"up" | "down"> {
    try {
      if (this.redis.client.status === "wait") await this.redis.client.connect();
      return (await this.redis.client.ping()) === "PONG" ? "up" : "down";
    } catch {
      return "down";
    }
  }
}
