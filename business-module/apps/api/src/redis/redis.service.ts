import { Injectable, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import { loadConfig } from "../config/config";

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor() {
    // 懒连接：应用启动不因为 Redis 暂时不可用而失败，健康检查会如实报告。
    this.client = new Redis(loadConfig().REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }
}
