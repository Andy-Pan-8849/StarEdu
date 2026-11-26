"use client";

// 平台控制台的首页：和租户首页同样的版式（欢迎语 + 几张数字卡 + 两个信息块），内容是平台运维关心的：
// 租户各状态的数量、服务是否在跑、最近的平台操作。卡片点进去打开对应的页面。
import { useTranslations } from "next-intl";
import * as React from "react";
import { PERMS } from "@staredu/shared";
import { bff } from "@/lib/bff";
import { useNav } from "../nav-context";
import { usePermissions } from "../permissions";
import { greetingKey } from "./home-page";

interface Tenant { id: string; status: "active" | "notified" | "suspended" | "provisioning" }
interface Health { database: { ok: boolean }; cache: { ok: boolean } }
interface External { state: "notConfigured" | "down" | "up" }
interface Links { grafana: External; langfuse: External }
interface Audit { id: string; action: string; targetType: string; actorAccountId: string | null; createdAt: string }

function Card({ title, value, hint, to }: { title: string; value: React.ReactNode; hint?: string; to?: string }) {
  const nav = useNav();
  const body = (
    <>
      <div className="text-xs text-muted">{title}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-muted">{hint}</div> : null}
    </>
  );
  const cls = "rounded-lg border border-border p-4 text-left";
  return to ? <button type="button" className={`${cls} hover:border-primary`} onClick={() => nav.openPage(to)}>{body}</button> : <div className={cls}>{body}</div>;
}

export function PlatformHomePage({ userName }: { userName: string }) {
  const t = useTranslations("platformHome");
  const perms = usePermissions();
  const nav = useNav();
  const [tenants, setTenants] = React.useState<Tenant[] | null>(null);
  const [health, setHealth] = React.useState<Health | null>(null);
  const [links, setLinks] = React.useState<Links | null>(null);
  const [audit, setAudit] = React.useState<Audit[] | null>(null);
  const canTenants = perms.has(PERMS.platformTenantList);
  const canMonitor = perms.has(PERMS.platformMonitorList);
  const canAudit = perms.has(PERMS.platformLogList);

  React.useEffect(() => {
    const quiet = () => undefined;
    if (canTenants) void bff<Tenant[]>("tenants").then(setTenants).catch(quiet);
    if (canMonitor) {
      void bff<Health>("monitor").then(setHealth).catch(quiet);
      void bff<Links>("external-links").then(setLinks).catch(quiet);
    }
    if (canAudit) void bff<Audit[]>("audit-logs?page=1&size=5").then(setAudit).catch(quiet);
  }, [canTenants, canMonitor, canAudit]);

  const count = (s: Tenant["status"]) => (tenants ?? []).filter((x) => x.status === s).length;
  const down = health ? [health.database.ok, health.cache.ok].filter((ok) => !ok).length : 0;
  return (
    <div className="space-y-4 text-sm">
      <div>
        <h2 suppressHydrationWarning className="text-xl font-semibold">{t(`greeting_${greetingKey(new Date().getHours())}`, { name: userName })}</h2>
        <p className="text-muted">{t("subtitle")}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tenants ? <Card title={t("tenants")} value={tenants.length} hint={t("tenantsActive") + " " + count("active")} to="platform/tenant/index" /> : null}
        {tenants ? <Card title={t("tenantsNotified")} value={count("notified")} to="platform/tenant/index" /> : null}
        {tenants ? <Card title={t("tenantsSuspended")} value={count("suspended")} to="platform/tenant/index" /> : null}
        {health ? <Card title={t("health")} value={down === 0 ? t("healthOk") : t("healthDown", { n: down })} to="platform/monitor/index" /> : null}
        {links ? <Card title={t("grafana")} value={t(`state_${links.grafana.state}`)} to="platform/monitor/index" /> : null}
        {links ? <Card title={t("langfuse")} value={t(`state_${links.langfuse.state}`)} to="platform/monitor/index" /> : null}
      </div>

      {audit ? (
        <section className="rounded-lg border border-border">
          <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <h3 className="font-medium">{t("recentActivity")}</h3>
            <button type="button" className="text-xs text-primary hover:underline" onClick={() => nav.openPage("platform/log/index")}>{t("viewAll")}</button>
          </header>
          <div className="p-4">
            {audit.length === 0 ? <p className="text-muted">{t("noActivity")}</p> : (
              <ul className="space-y-2">
                {audit.map((a) => (
                  <li key={a.id} className="flex items-baseline justify-between gap-3">
                    <span><span className="font-medium">{a.action}</span> <span className="text-muted">· {a.targetType} · {a.actorAccountId?.slice(0, 8) ?? t("system")}</span></span>
                    <span className="text-muted">{new Date(a.createdAt).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
