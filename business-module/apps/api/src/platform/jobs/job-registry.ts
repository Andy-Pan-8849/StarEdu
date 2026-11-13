// 定时任务注册表（白名单）：界面和接口里的任务名只能取这里的，任意字符串被拒。
// 加新任务 = 在这里登记一项，别处不用动。
import { realmName } from "@staredu/shared";
import type { AccountsService } from "../../accounts/accounts.service";
import type { StaffService } from "../../hr/staff.service";
import type { PlatformPrismaService } from "../platform-prisma.service";
import { runInScope } from "../../tenancy/request-scope";

export interface JobDeps {
  db: PlatformPrismaService;
  accounts: AccountsService;
  staff: StaffService;
}

export interface JobDefinition {
  code: string;
  name: string;
  description: string;
  /** 5 段 cron（分 时 日 月 周），最细到分钟 */
  defaultCron: string;
  run(deps: JobDeps): Promise<string>;
}

export const JOBS: JobDefinition[] = [
  {
    code: "accounts.reconcile",
    name: "Reconcile accounts with the identity service",
    description: "For every active tenant, compare business accounts with Keycloak users and repair differences towards the business database.",
    defaultCron: "30 3 * * *",
    async run({ db, accounts }) {
      const tenants = await db.tenant.findMany({ where: { status: { in: ["active", "notified"] } } });
      let discrepancies = 0;
      let fixed = 0;
      const failures: string[] = [];
      for (const t of tenants) {
        try {
          const report = await runInScope({ kind: "tenant", tenantId: t.id, code: t.code, name: t.name, status: t.status }, () => accounts.reconcile({ accountId: null }, true));
          discrepancies += report.discrepancies.length;
          fixed += report.fixed;
        } catch (err) {
          failures.push(`${realmName("tenant", t.code)}: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (failures.length) throw new Error(`${tenants.length} tenants, ${failures.length} failed: ${failures.join("; ")}`);
      return `${tenants.length} tenants checked, ${discrepancies} differences, ${fixed} fixed`;
    },
  },
  {
    code: "tenants.suspend-due",
    name: "Suspend tenants whose planned suspension time has passed",
    description: "Tenants that were notified and whose planned suspension time is in the past become suspended.",
    defaultCron: "*/10 * * * *",
    async run({ db }) {
      const due = await db.tenant.findMany({ where: { status: "notified", plannedSuspendAt: { lte: new Date() } } });
      for (const t of due) {
        await db.tenant.update({ where: { id: t.id }, data: { status: "suspended", suspendedAt: new Date() } });
        await db.platformAuditLog.create({ data: { actorAccountId: null, action: "tenant.suspend", targetType: "tenant", targetId: t.id, detail: { by: "job tenants.suspend-due" } } });
      }
      return `${due.length} tenants suspended`;
    },
  },
];

JOBS.push({
  code: "staff.apply-effective",
  name: "Apply scheduled employment changes",
  description: "Staff whose leave or end-of-employment date has arrived are switched to their new status: assignments end, admin access is withdrawn and sessions are ended.",
  defaultCron: "5 0 * * *",
  async run({ db, staff }) {
    const tenants = await db.tenant.findMany({ where: { status: { in: ["active", "notified"] } } });
    let applied = 0;
    for (const t of tenants) applied += await runInScope({ kind: "tenant", tenantId: t.id, code: t.code, name: t.name, status: t.status }, () => staff.applyDue());
    return `${applied} changes applied across ${tenants.length} tenants`;
  },
});

export const OPERATION_LOG_PARAM_DAYS = 180;

JOBS.push({
  code: "logs.purge-params",
  name: "Remove request parameters from old operation logs",
  description: `Operation log entries keep their parameters for ${OPERATION_LOG_PARAM_DAYS} days; after that the parameters are cleared and the rest of the entry is kept.`,
  defaultCron: "15 2 * * *",
  async run({ db }) {
    const cutoff = new Date(Date.now() - OPERATION_LOG_PARAM_DAYS * 864e5);
    const count = await db.$executeRaw`UPDATE biz.operation_log SET params = NULL WHERE created_at < ${cutoff} AND params IS NOT NULL`;
    return `parameters cleared on ${count} entries older than ${OPERATION_LOG_PARAM_DAYS} days`;
  },
});

export const jobByCode = (code: string): JobDefinition | undefined => JOBS.find((j) => j.code === code);
