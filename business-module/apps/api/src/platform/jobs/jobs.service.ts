// 定时任务：调度设置存在库里，任务本身只能取自注册表；执行有日志；多实例下用 Redis 锁互斥。
import { ConflictException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Cron } from "croner";
import { AccountsService } from "../../accounts/accounts.service";
import { StaffService } from "../../hr/staff.service";
import { RedisService } from "../../redis/redis.service";
import { PlatformPrismaService } from "../platform-prisma.service";
import { JOBS, jobByCode } from "./job-registry";

const LOCK_SECONDS = 600;

/** 校验 5 段 cron；返回下一次运行时间。无效或带秒的写法一律拒绝。 */
export function checkCron(expr: string): Date | null {
  if (expr.trim().split(/\s+/).length !== 5) throw new Error("A cron expression needs exactly 5 fields (minute hour day month weekday)");
  try {
    return new Cron(expr, { paused: true }).nextRun();
  } catch (err) {
    throw new Error(`Invalid cron expression: ${err instanceof Error ? err.message : err}`);
  }
}

@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private timers = new Map<string, Cron>();

  constructor(
    private readonly db: PlatformPrismaService,
    private readonly redis: RedisService,
    private readonly accounts: AccountsService,
    private readonly staff: StaffService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.JOBS_SCHEDULER === "off") return;
    try {
      for (const j of JOBS) await this.db.scheduledJob.upsert({ where: { code: j.code }, create: { code: j.code, cron: j.defaultCron, enabled: false }, update: {} });
      for (const row of await this.db.scheduledJob.findMany({ where: { enabled: true } })) this.schedule(row.code, row.cron);
    } catch {
      /* 平台库暂不可用不让应用起不来；任务列表接口会如实报错 */
    }
  }

  onModuleDestroy(): void {
    for (const t of this.timers.values()) t.stop();
    this.timers.clear();
  }

  private schedule(code: string, cron: string): void {
    this.timers.get(code)?.stop();
    this.timers.set(code, new Cron(cron, () => void this.run(code, "schedule").catch(() => undefined)));
  }

  async list() {
    const rows = new Map((await this.db.scheduledJob.findMany({})).map((r) => [r.code, r]));
    return JOBS.map((j) => {
      const r = rows.get(j.code);
      const cron = r?.cron ?? j.defaultCron;
      return { code: j.code, name: j.name, description: j.description, cron, enabled: r?.enabled ?? false, lastRunAt: r?.lastRunAt ?? null, lastStatus: r?.lastStatus ?? null, nextRun: r?.enabled ? checkCron(cron) : null };
    });
  }

  async update(code: string, patch: { cron?: string; enabled?: boolean }) {
    const def = jobByCode(code);
    if (!def) throw new NotFoundException("Unknown job"); // 只认注册表里的任务名
    if (patch.cron !== undefined) {
      try {
        checkCron(patch.cron);
      } catch (err) {
        throw new ConflictException(err instanceof Error ? err.message : String(err));
      }
    }
    const row = await this.db.scheduledJob.upsert({ where: { code }, create: { code, cron: patch.cron ?? def.defaultCron, enabled: patch.enabled ?? false }, update: patch });
    if (row.enabled) this.schedule(code, row.cron);
    else {
      this.timers.get(code)?.stop();
      this.timers.delete(code);
    }
    return (await this.list()).find((j) => j.code === code);
  }

  runs(code: string) {
    if (!jobByCode(code)) throw new NotFoundException("Unknown job");
    return this.db.jobRun.findMany({ where: { jobCode: code }, orderBy: { startedAt: "desc" }, take: 50 });
  }

  /** 立即执行（或按计划执行）。同一任务同一时间只会有一个实例在跑（Redis 锁）。 */
  async run(code: string, trigger: "manual" | "schedule") {
    const def = jobByCode(code);
    if (!def) throw new NotFoundException("Unknown job");
    const lock = `job:lock:${code}`;
    if ((await this.redis.client.set(lock, "1", "EX", LOCK_SECONDS, "NX")) !== "OK") throw new ConflictException("The job is already running");
    const run = await this.db.jobRun.create({ data: { jobCode: code, trigger, status: "running" } });
    let status = "success";
    let message: string;
    try {
      message = await def.run({ db: this.db, accounts: this.accounts, staff: this.staff });
    } catch (err) {
      status = "failed";
      message = err instanceof Error ? err.message : String(err);
    } finally {
      await this.redis.client.del(lock);
    }
    await this.db.jobRun.update({ where: { id: run.id }, data: { status, message, finishedAt: new Date() } });
    await this.db.scheduledJob.upsert({ where: { code }, create: { code, cron: def.defaultCron, enabled: false, lastRunAt: new Date(), lastStatus: status }, update: { lastRunAt: new Date(), lastStatus: status } });
    return { id: run.id, code, status, message };
  }
}
