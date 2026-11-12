import { Controller, Get, HttpException, HttpStatus } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { HealthService } from "./health.service";

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  // 任一依赖不可用就返回 503，容器编排据此判断是否健康。
  @Public()
  @Get("healthz")
  async healthz() {
    const report = await this.health.check();
    if (report.status !== "ok") throw new HttpException(report, HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
