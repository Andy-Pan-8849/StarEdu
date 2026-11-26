// 轻量监控（Node 的 os 模块与 Redis INFO）、外部链接（Swagger、Grafana 探活）、定时任务接口。
import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { cpus, freemem, hostname, loadavg, platform, totalmem, uptime } from "node:os";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { RequirePermissions } from "../auth/decorators";
import { parse } from "../common/http";
import { loadConfig } from "../config/config";
import { RedisService } from "../redis/redis.service";
import { JobsService } from "./jobs/jobs.service";
import { PAuth, PlatformRoute, type PlatformAuthContext } from "./platform.decorators";
import { PlatformAuditService } from "./platform-audit.service";
import { PlatformPrismaService } from "./platform-prisma.service";

function parseInfo(text: string): Record<string, string> {
  return Object.fromEntries(text.split("\r\n").filter((l) => l && !l.startsWith("#") && l.includes(":")).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1)]));
}

/** 探一个外部看板：没配地址 → notConfigured；连不上或不健康 → down；否则 up。 */
async function probe(url: string | undefined, healthPath: string): Promise<{ configured: boolean; url: string | null; up: boolean; state: "notConfigured" | "down" | "up" }> {
  if (!url) return { configured: false, url: null, up: false, state: "notConfigured" };
  let up = false;
  try {
    up = (await fetch(`${url.replace(/\/$/, "")}${healthPath}`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    up = false;
  }
  return { configured: true, url, up, state: up ? "up" : "down" };
}

@PlatformRoute()
@Controller("api/platform")
export class MonitorController {
  constructor(
    private readonly redis: RedisService,
    private readonly db: PlatformPrismaService,
    private readonly jobs: JobsService,
    private readonly audit: PlatformAuditService,
  ) {}

  @Get("monitor")
  @RequirePermissions(PERMS.platformMonitorList)
  async monitor() {
    const mem = process.memoryUsage();
    const started = Date.now();
    let dbOk = true;
    try {
      await this.db.$queryRaw`SELECT 1`;
    } catch {
      dbOk = false;
    }
    const dbMs = Date.now() - started;
    let cache: Record<string, unknown>;
    try {
      const info = parseInfo(await this.redis.client.info());
      cache = {
        ok: true,
        version: info.redis_version,
        uptimeSeconds: Number(info.uptime_in_seconds),
        connectedClients: Number(info.connected_clients),
        usedMemoryBytes: Number(info.used_memory),
        keyspaceHits: Number(info.keyspace_hits),
        keyspaceMisses: Number(info.keyspace_misses),
        keys: await this.redis.client.dbsize(),
      };
    } catch (err) {
      cache = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    return {
      server: {
        hostname: hostname(),
        platform: platform(),
        nodeVersion: process.version,
        uptimeSeconds: Math.round(uptime()),
        processUptimeSeconds: Math.round(process.uptime()),
        cpuCount: cpus().length,
        loadAverage: loadavg(),
        totalMemoryBytes: totalmem(),
        freeMemoryBytes: freemem(),
        processRssBytes: mem.rss,
        processHeapUsedBytes: mem.heapUsed,
      },
      cache,
      database: { ok: dbOk, latencyMs: dbMs },
    };
  }

  /** Swagger 文档页的地址（只有开启时才有），和 Grafana、Langfuse 的地址与状态（探活）：未配置 / 没在运行 / 运行中。 */
  @Get("external-links")
  @RequirePermissions(PERMS.platformMonitorList)
  async externalLinks() {
    const config = loadConfig();
    const dev = process.env.NODE_ENV !== "production";
    const swaggerOn = config.SWAGGER_ENABLED === "true" || (config.SWAGGER_ENABLED === undefined && dev);
    const [grafana, langfuse] = await Promise.all([
      probe(config.GRAFANA_URL ?? (dev ? "http://localhost:3300" : undefined), "/api/health"),
      probe(config.LANGFUSE_URL ?? (dev ? "http://localhost:3100" : undefined), "/api/public/health"),
    ]);
    return { swagger: { enabled: swaggerOn, path: swaggerOn ? "/api-docs" : null }, grafana, langfuse };
  }

  // ---- 定时任务 ----
  @Get("jobs")
  @RequirePermissions(PERMS.platformJobList)
  jobList() {
    return this.jobs.list();
  }

  @Get("jobs/:code/runs")
  @RequirePermissions(PERMS.platformJobList)
  runs(@Param("code") code: string) {
    return this.jobs.runs(code);
  }

  @Patch("jobs/:code")
  @RequirePermissions(PERMS.platformJobEdit)
  async updateJob(@PAuth() auth: PlatformAuthContext, @Param("code") code: string, @Body() body: unknown) {
    const patch = parse(z.object({ cron: z.string().max(100).optional(), enabled: z.boolean().optional() }).strict(), body);
    const job = await this.jobs.update(code, patch);
    await this.audit.record(auth.accountId, "job.update", "job", code, patch);
    return job;
  }

  @Post("jobs/:code/run")
  @RequirePermissions(PERMS.platformJobRun)
  async runJob(@PAuth() auth: PlatformAuthContext, @Param("code") code: string) {
    const result = await this.jobs.run(code, "manual");
    await this.audit.record(auth.accountId, "job.run", "job", code, { status: result.status });
    return result;
  }
}
