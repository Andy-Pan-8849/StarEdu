// 集成测试：连真实的 Postgres 和 Redis（make biz-up 之后；CI 里由服务容器提供）。
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";

describe("GET /healthz (real database and redis)", () => {
  it("reports both dependencies up", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const res = await request(app.getHttpServer()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ database: "up", redis: "up" });
    await app.close();
  });
});
