import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { HealthController } from "../src/health/health.controller";
import { HealthService } from "../src/health/health.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { RedisService } from "../src/redis/redis.service";

async function appWith(prisma: unknown, redis: unknown): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      HealthService,
      { provide: PrismaService, useValue: prisma },
      { provide: RedisService, useValue: redis },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

const prismaUp = { $queryRaw: async () => [{ "?column?": 1 }] };
const prismaDown = {
  $queryRaw: async () => {
    throw new Error("connection refused");
  },
};
const redisUp = { client: { status: "ready", ping: async () => "PONG" } };
const redisDown = {
  client: {
    status: "end",
    ping: async () => {
      throw new Error("connection refused");
    },
  },
};

describe("GET /healthz (dependencies faked)", () => {
  it("returns 200 when database and redis are up", async () => {
    const app = await appWith(prismaUp, redisUp);
    const res = await request(app.getHttpServer()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", checks: { database: "up", redis: "up" } });
    await app.close();
  });

  it("returns 503 and says which dependency is down", async () => {
    const app = await appWith(prismaDown, redisUp);
    const res = await request(app.getHttpServer()).get("/healthz");
    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ database: "down", redis: "up" });
    await app.close();
  });

  it("returns 503 when redis is down", async () => {
    const app = await appWith(prismaUp, redisDown);
    const res = await request(app.getHttpServer()).get("/healthz");
    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ database: "up", redis: "down" });
    await app.close();
  });
});
