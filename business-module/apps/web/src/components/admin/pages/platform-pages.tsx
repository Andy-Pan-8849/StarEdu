"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { PERMS } from "@staredu/shared";
import { Button } from "@/components/ui/button";
import { bff } from "@/lib/bff";
import { Modal } from "../modal";
import { usePromptDialog } from "../prompt-dialog";
import { DataTable, type Column } from "../data-table";
import { Can, PermButton } from "../permissions";
import { TreeSelect } from "../tree-select";
import type { TreeNode } from "../tree";
import { submitIds } from "../tree";
import { useList } from "./use-api";

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "");
const H2 = ({ children }: { children: React.ReactNode }) => <h2 className="mb-3 text-lg font-semibold">{children}</h2>;

function useTable() {
  const t = useTranslations("table");
  return { empty: t("empty"), loading: t("loading"), labels: { actions: t("actions"), selectAll: t("selectAll"), selectRow: t("selectRow"), clearSelection: t("clearSelection"), selected: (n: number) => t("selected", { n }), previous: t("previous"), next: t("next"), page: (p: number, n: number) => t("page", { page: p, pages: n }) } };
}

interface TenantRow {
  id: string;
  code: string;
  name: string;
  type: string;
  status: "active" | "notified" | "suspended" | "provisioning";
  loginUrl: string;
  admin: { email: string | null; status: string } | null;
}

interface MenuApiNode {
  id: string;
  name: string;
  nameKey: string | null;
  children?: MenuApiNode[];
}

export function TenantsPage() {
  const t = useTranslations("pages.tenants");
  const { ask, dialog } = usePromptDialog();
  const tt = useTable();
  const { rows, loading, error, reload } = useList<TenantRow>("tenants");
  const [message, setMessage] = React.useState<string | null>(null);
  const [form, setForm] = React.useState({ code: "", name: "", type: "direct", adminEmail: "" });
  const [creating, setCreating] = React.useState(false);
  const [grantFor, setGrantFor] = React.useState<TenantRow | null>(null);
  const [securityFor, setSecurityFor] = React.useState<TenantRow | null>(null);
  const [quotaFor, setQuotaFor] = React.useState<TenantRow | null>(null);

  async function act(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      setMessage(ok);
    } catch (e) {
      setMessage((e as Error).message);
    }
    reload();
  }
  const status = (r: TenantRow, action: string, extra: Record<string, unknown> = {}) => bff(`tenants/${r.id}/status`, { method: "POST", body: { action, ...extra } });

  const columns: Column<TenantRow>[] = [
    { key: "name", header: t("name"), cell: (r) => r.name },
    { key: "code", header: t("code"), cell: (r) => <a className="underline" href={r.loginUrl} target="_blank" rel="noopener noreferrer">{r.code}</a> },
    { key: "type", header: t("type"), cell: (r) => t(`type_${r.type}`) },
    { key: "status", header: t("status"), cell: (r) => t(`status_${r.status}`) },
    { key: "admin", header: t("admin"), cell: (r) => (r.admin ? `${r.admin.email ?? ""} (${r.admin.status})` : "") },
    {
      key: "actions",
      header: "",
      cell: (r) => (
        <div className="flex flex-wrap gap-1">
          {r.status === "active" ? (
            <PermButton perm={PERMS.platformTenantStatus} size="sm" variant="outline" onClick={() => void ask(t("notify"), [{ name: "text", label: t("noticePrompt"), type: "textarea" }]).then((v) => { if (v) void act(() => status(r, "notify", { noticeText: v.text }), t("notified")); })}>{t("notify")}</PermButton>
          ) : null}
          {r.status === "notified" ? (
            <PermButton perm={PERMS.platformTenantStatus} size="sm" variant="outline" onClick={() => void act(() => status(r, "cancel-notice"), t("done"))}>{t("cancelNotice")}</PermButton>
          ) : null}
          {r.status === "active" || r.status === "notified" ? (
            <PermButton perm={PERMS.platformTenantStatus} size="sm" variant="outline" onClick={() => window.confirm(t("confirmSuspend", { name: r.name })) && void act(() => status(r, "suspend"), t("done"))}>{t("suspend")}</PermButton>
          ) : null}
          {r.status === "suspended" ? (
            <PermButton perm={PERMS.platformTenantStatus} size="sm" variant="outline" onClick={() => void act(() => status(r, "restore"), t("done"))}>{t("restore")}</PermButton>
          ) : null}
          <PermButton perm={PERMS.platformTenantGrant} size="sm" variant="outline" onClick={() => setGrantFor(r)}>{t("features")}</PermButton>
          <PermButton perm={PERMS.platformTenantSecurity} size="sm" variant="outline" onClick={() => setSecurityFor(r)}>{t("security")}</PermButton>
          <PermButton perm={PERMS.platformTenantQuota} size="sm" variant="outline" onClick={() => setQuotaFor(r)}>{t("quota")}</PermButton>
          <PermButton perm={PERMS.platformTenantAdmin} size="sm" variant="outline" onClick={() => void act(() => bff(`tenants/${r.id}/admin/invite`, { method: "POST" }), t("inviteSent"))}>{t("resendInvite")}</PermButton>
          <PermButton perm={PERMS.platformTenantAdmin} size="sm" variant="outline" onClick={() => void act(() => bff(`tenants/${r.id}/admin/unlock`, { method: "POST" }), t("unlocked"))}>{t("unlock")}</PermButton>
        </div>
      ),
    },
  ];

  return (
    <section>
      {dialog}
      <H2>{t("title")}</H2>
      {error ? <p role="alert" className="mb-2 text-sm text-red-600">{error}</p> : null}
      {message ? <p role="status" className="mb-2 text-sm text-muted">{message}</p> : null}
      <Can perm={PERMS.platformTenantAdd}>
        <div className="mb-3">
          {creating ? (
            <Modal title={t("new")} onClose={() => setCreating(false)}>
            <form
              className="flex flex-col gap-3 text-sm"
              onSubmit={(e) => { e.preventDefault(); void act(() => bff("tenants", { method: "POST", body: form }), t("created")).then(() => setCreating(false)); }}
            >
              {(["code", "name", "adminEmail"] as const).map((k) => (
                <label key={k} className="flex flex-col gap-1">
                  {t(k === "adminEmail" ? "adminEmail" : k)}
                  <input required className="rounded-md border border-border bg-transparent px-2 py-1" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                </label>
              ))}
              <label className="flex flex-col gap-1">
                {t("type")}
                <select className="rounded-md border border-border bg-transparent px-2 py-1" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  <option value="direct">{t("type_direct")}</option>
                  <option value="franchise">{t("type_franchise")}</option>
                </select>
              </label>
              <div className="mt-2 flex gap-2 border-t border-border pt-3">
                <Button type="submit" size="sm">{t("create")}</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setCreating(false)}>{t("cancel")}</Button>
              </div>
            </form>
            </Modal>
          ) : (
            <Button size="sm" onClick={() => setCreating(true)}>{t("new")}</Button>
          )}
        </div>
      </Can>
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
      {grantFor ? <GrantsPanel tenant={grantFor} onClose={() => { setGrantFor(null); reload(); }} /> : null}
      {securityFor ? <SecurityPanel key={securityFor.id} tenant={securityFor} onClose={() => setSecurityFor(null)} /> : null}
      {quotaFor ? <QuotaPanel key={quotaFor.id} tenant={quotaFor} onClose={() => setQuotaFor(null)} /> : null}
    </section>
  );
}

interface SecurityData {
  realm: string;
  security: {
    password: { length: number; upperCase: number; lowerCase: number; digits: number; specialChars: number; history: number };
    lockout: { failureFactor: number; waitIncrementMinutes: number; maxWaitMinutes: number; permanent: boolean };
    session: { idleMinutes: number; maxHours: number };
    mfa: "off" | "all";
  };
  google: { configured: boolean; enabled: boolean; clientId: string | null; hasSecret: boolean; redirectUri: string };
}

/** 租户"登录与安全"：密码策略、登录失败锁定、会话时长、两步验证，和 Google 登录。 */
function SecurityPanel({ tenant, onClose }: { tenant: TenantRow; onClose: () => void }) {
  const t = useTranslations("pages.tenants");
  const [data, setData] = React.useState<SecurityData | null>(null);
  const [form, setForm] = React.useState<SecurityData["security"] | null>(null);
  const [google, setGoogle] = React.useState({ clientId: "", clientSecret: "", enabled: true });
  const [msg, setMsg] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    const d = await bff<SecurityData>(`tenants/${tenant.id}/security`);
    setData(d);
    setForm(d.security);
    setGoogle({ clientId: d.google.clientId ?? "", clientSecret: "", enabled: d.google.configured ? d.google.enabled : true });
  }, [tenant.id]);
  React.useEffect(() => { void load().catch((e) => setMsg((e as Error).message)); }, [load]);
  if (!data || !form) return <p className="mt-3 text-sm text-muted">{msg ?? "…"}</p>;
  async function run(fn: () => Promise<unknown>) {
    try { await fn(); await load(); setMsg(t("saved")); } catch (e) { setMsg((e as Error).message); }
  }
  const field = (label: string, value: number, set: (n: number) => void, hint?: string) => (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <input type="number" className="w-28 rounded-md border border-border bg-transparent px-2 py-1" value={value} onChange={(e) => set(Number(e.target.value))} />
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </label>
  );
  const pw = form.password;
  const setPw = (k: keyof typeof pw, n: number) => setForm({ ...form, password: { ...pw, [k]: n } });
  return (
    <Modal wide title={t("securityOf", { name: tenant.name })} onClose={onClose}>
    <div className="text-sm">
      <fieldset className="mb-3 flex flex-wrap gap-3"><legend className="mb-1 text-sm font-medium">{t("passwordRules")}</legend>
        {field(t("pwLength"), pw.length, (n) => setPw("length", n))}
        {field(t("pwUpper"), pw.upperCase, (n) => setPw("upperCase", n))}
        {field(t("pwLower"), pw.lowerCase, (n) => setPw("lowerCase", n))}
        {field(t("pwDigits"), pw.digits, (n) => setPw("digits", n))}
        {field(t("pwSpecial"), pw.specialChars, (n) => setPw("specialChars", n))}
        {field(t("pwHistory"), pw.history, (n) => setPw("history", n), t("pwHistoryHint"))}
      </fieldset>
      <fieldset className="mb-3 flex flex-wrap gap-3"><legend className="mb-1 text-sm font-medium">{t("lockoutRules")}</legend>
        {field(t("failures"), form.lockout.failureFactor, (n) => setForm({ ...form, lockout: { ...form.lockout, failureFactor: n } }))}
        {field(t("waitMinutes"), form.lockout.waitIncrementMinutes, (n) => setForm({ ...form, lockout: { ...form.lockout, waitIncrementMinutes: n } }))}
        {field(t("maxWaitMinutes"), form.lockout.maxWaitMinutes, (n) => setForm({ ...form, lockout: { ...form.lockout, maxWaitMinutes: n } }))}
      </fieldset>
      <fieldset className="mb-3 flex flex-wrap gap-3"><legend className="mb-1 text-sm font-medium">{t("sessionRules")}</legend>
        {field(t("idleMinutes"), form.session.idleMinutes, (n) => setForm({ ...form, session: { ...form.session, idleMinutes: n } }))}
        {field(t("maxHours"), form.session.maxHours, (n) => setForm({ ...form, session: { ...form.session, maxHours: n } }))}
      </fieldset>
      <label className="mb-3 flex flex-col gap-1 text-sm">
        {t("mfa")}
        <select className="w-72 rounded-md border border-border bg-transparent px-2 py-1" value={form.mfa} onChange={(e) => setForm({ ...form, mfa: e.target.value as "off" | "all" })}>
          <option value="off">{t("mfaOff")}</option>
          <option value="all">{t("mfaAll")}</option>
        </select>
      </label>
      <div className="mb-4 flex items-center gap-2 text-sm">
        <PermButton perm={PERMS.platformTenantSecurity} size="sm" onClick={() => void run(() => bff(`tenants/${tenant.id}/security`, { method: "PUT", body: form }))}>{t("save")}</PermButton>
      </div>
      <fieldset className="border-t border-border pt-3"><legend className="mb-1 text-sm font-medium">{t("googleTitle")}</legend>
        <p className="mb-2 text-xs text-muted">{t("googleHelp")}</p>
        <p className="mb-2 text-sm">{t("redirectUri")}: <code className="select-all break-all">{data.google.redirectUri}</code></p>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1">{t("googleClientId")}<input className="w-96 rounded-md border border-border bg-transparent px-2 py-1" value={google.clientId} onChange={(e) => setGoogle({ ...google, clientId: e.target.value })} /></label>
          <label className="flex flex-col gap-1">{t("googleSecret")}<input type="password" autoComplete="off" placeholder={data.google.hasSecret ? t("secretKept") : ""} className="w-64 rounded-md border border-border bg-transparent px-2 py-1" value={google.clientSecret} onChange={(e) => setGoogle({ ...google, clientSecret: e.target.value })} /></label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={google.enabled} onChange={(e) => setGoogle({ ...google, enabled: e.target.checked })} />{t("googleEnabled")}</label>
          <PermButton perm={PERMS.platformTenantSecurity} size="sm" onClick={() => void run(() => bff(`tenants/${tenant.id}/security/google`, { method: "PUT", body: { clientId: google.clientId, enabled: google.enabled, ...(google.clientSecret ? { clientSecret: google.clientSecret } : {}) } }))}>{t("save")}</PermButton>
          {data.google.configured ? <PermButton perm={PERMS.platformTenantSecurity} size="sm" variant="outline" onClick={() => window.confirm(t("confirmRemoveGoogle")) && void run(() => bff(`tenants/${tenant.id}/security/google`, { method: "DELETE" }))}>{t("googleRemove")}</PermButton> : null}
        </div>
      </fieldset>
      <div className="mt-3 flex items-center gap-2 text-sm">
        <Button size="sm" variant="outline" onClick={onClose}>{t("close")}</Button>
        {msg ? <span role="status" className="text-muted">{msg}</span> : null}
      </div>
    </div>
    </Modal>
  );
}

function toTree(nodes: MenuApiNode[], label: (n: MenuApiNode) => string): TreeNode[] {
  return nodes.map((n) => ({ id: n.id, label: label(n), children: n.children?.length ? toTree(n.children, label) : undefined }));
}

function GrantsPanel({ tenant, onClose }: { tenant: TenantRow; onClose: () => void }) {
  const t = useTranslations("pages.tenants");
  const tm = useTranslations();
  const [data, setData] = React.useState<{ tree: { admin: MenuApiNode[]; portal: MenuApiNode[] }; granted: string[] } | null>(null);
  const [value, setValue] = React.useState<string[]>([]);
  const [msg, setMsg] = React.useState<string | null>(null);
  React.useEffect(() => {
    void bff<{ tree: { admin: MenuApiNode[]; portal: MenuApiNode[] }; granted: string[] }>(`tenants/${tenant.id}/grants`).then((d) => { setData(d); setValue(d.granted); });
  }, [tenant.id]);
  if (!data) return <Modal title={t("features")} onClose={onClose}><p className="text-sm text-muted">…</p></Modal>;
  const label = (n: MenuApiNode) => (n.nameKey && tm.has(n.nameKey) ? tm(n.nameKey) : n.name);
  const tree = [...toTree(data.tree.admin, label), ...toTree(data.tree.portal, label)];
  return (
    <Modal title={t("featuresOf", { name: tenant.name })} onClose={onClose}>
    <div className="text-sm">
      <TreeSelect label={t("features")} nodes={tree} value={value} onChange={setValue} />
      <div className="mt-3 flex items-center gap-2 text-sm">
        <PermButton perm={PERMS.platformTenantGrant} size="sm" onClick={async () => { try { await bff(`tenants/${tenant.id}/grants`, { method: "PUT", body: { menuIds: submitIds(tree, new Set(value)) } }); setMsg(t("saved")); } catch (e) { setMsg((e as Error).message); } }}>{t("save")}</PermButton>
        <Button size="sm" variant="outline" onClick={onClose}>{t("close")}</Button>
        {msg ? <span role="status" className="text-muted">{msg}</span> : null}
      </div>
    </div>
    </Modal>
  );
}

interface JobRow {
  code: string;
  name: string;
  cron: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  nextRun: string | null;
}

export function JobsPage() {
  const t = useTranslations("pages.jobs");
  const { ask, dialog } = usePromptDialog();
  const tt = useTable();
  const { rows, loading, error, reload } = useList<JobRow>("jobs");
  const [message, setMessage] = React.useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setMessage(null);
    } catch (e) {
      setMessage((e as Error).message);
    }
    reload();
  };
  const columns: Column<JobRow>[] = [
    { key: "name", header: t("name"), cell: (r) => <span title={r.code}>{r.name}</span> },
    { key: "cron", header: t("cron"), cell: (r) => <code>{r.cron}</code> },
    { key: "enabled", header: t("enabled"), cell: (r) => (r.enabled ? t("on") : t("off")) },
    { key: "last", header: t("lastRun"), cell: (r) => `${when(r.lastRunAt)} ${r.lastStatus ?? ""}` },
    { key: "next", header: t("nextRun"), cell: (r) => when(r.nextRun) },
    {
      key: "actions",
      header: "",
      cell: (r) => (
        <div className="flex gap-1">
          <PermButton perm={PERMS.platformJobEdit} size="sm" variant="outline" onClick={() => void act(() => bff(`jobs/${r.code}`, { method: "PATCH", body: { enabled: !r.enabled } }))}>{r.enabled ? t("disable") : t("enable")}</PermButton>
          <PermButton perm={PERMS.platformJobEdit} size="sm" variant="outline" onClick={() => void ask(t("editCron"), [{ name: "cron", label: t("cronPrompt"), initial: r.cron }]).then((v) => { if (v) void act(() => bff(`jobs/${r.code}`, { method: "PATCH", body: { cron: v.cron } })); })}>{t("editCron")}</PermButton>
          <PermButton perm={PERMS.platformJobRun} size="sm" onClick={() => void act(() => bff(`jobs/${r.code}/run`, { method: "POST" }))}>{t("runNow")}</PermButton>
        </div>
      ),
    },
  ];
  return (
    <section>
      {dialog}
      <H2>{t("title")}</H2>
      {error ? <p role="alert" className="mb-2 text-sm text-red-600">{error}</p> : null}
      {message ? <p role="alert" className="mb-2 text-sm text-red-600">{message}</p> : null}
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.code} loading={loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
    </section>
  );
}

interface Monitor {
  server: { hostname: string; nodeVersion: string; cpuCount: number; loadAverage: number[]; totalMemoryBytes: number; freeMemoryBytes: number; processRssBytes: number; uptimeSeconds: number };
  cache: { ok: boolean; version?: string; usedMemoryBytes?: number; connectedClients?: number; keys?: number; error?: string };
  database: { ok: boolean; latencyMs: number };
}
interface Links {
  swagger: { enabled: boolean; path: string | null };
  grafana: { configured: boolean; url: string | null; up: boolean };
}
const mb = (n: number | undefined) => (n === undefined ? "" : `${Math.round(n / 1048576)} MB`);

export function MonitorPage() {
  const t = useTranslations("pages.monitor");
  const [m, setM] = React.useState<Monitor | null>(null);
  const [links, setLinks] = React.useState<Links | null>(null);
  React.useEffect(() => {
    void bff<Monitor>("monitor").then(setM);
    void bff<Links>("external-links").then(setLinks);
  }, []);
  const Card = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="rounded-md border border-border p-3 text-sm">
      <h3 className="mb-2 font-medium">{title}</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">{children}</dl>
    </div>
  );
  const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (<><dt className="text-muted">{k}</dt><dd>{v}</dd></>);
  return (
    <section>
      <H2>{t("title")}</H2>
      <div className="grid gap-3 md:grid-cols-3">
        <Card title={t("server")}>
          <Row k={t("host")} v={m?.server.hostname} />
          <Row k="Node" v={m?.server.nodeVersion} />
          <Row k={t("cpus")} v={m?.server.cpuCount} />
          <Row k={t("load")} v={m?.server.loadAverage.map((x) => x.toFixed(2)).join(" ")} />
          <Row k={t("memory")} v={m ? `${mb(m.server.totalMemoryBytes - m.server.freeMemoryBytes)} / ${mb(m.server.totalMemoryBytes)}` : ""} />
          <Row k={t("process")} v={mb(m?.server.processRssBytes)} />
        </Card>
        <Card title={t("cache")}>
          <Row k={t("status")} v={m ? (m.cache.ok ? t("up") : m.cache.error) : ""} />
          <Row k={t("version")} v={m?.cache.version} />
          <Row k={t("memory")} v={mb(m?.cache.usedMemoryBytes)} />
          <Row k={t("clients")} v={m?.cache.connectedClients} />
          <Row k={t("keys")} v={m?.cache.keys} />
        </Card>
        <Card title={t("database")}>
          <Row k={t("status")} v={m ? (m.database.ok ? t("up") : t("down")) : ""} />
          <Row k={t("latency")} v={m ? `${m.database.latencyMs} ms` : ""} />
        </Card>
      </div>
      <div className="mt-4 flex flex-wrap gap-3 text-sm">
        {links?.swagger.enabled ? <a className="underline" href={`${window.location.protocol}//${window.location.hostname}:4000${links.swagger.path}`} target="_blank" rel="noopener noreferrer">{t("swagger")} ↗</a> : <span className="text-muted">{t("swaggerOff")}</span>}
        {links?.grafana.configured && links.grafana.up ? <a className="underline" href={links.grafana.url ?? "#"} target="_blank" rel="noopener noreferrer">{t("grafana")} ↗</a> : links ? <span className="text-muted">{t("grafanaDown")}</span> : null}
      </div>
    </section>
  );
}

interface AuditRow { id: string; action: string; targetType: string; targetId: string | null; actorAccountId: string | null; createdAt: string }

export function PlatformAuditPage() {
  const t = useTranslations("pages.platformAudit");
  const tt = useTable();
  const [page, setPage] = React.useState(1);
  const { rows, loading, error } = useList<AuditRow>(`audit-logs?page=${page}&size=20`);
  const columns: Column<AuditRow>[] = [
    { key: "time", header: t("time"), cell: (r) => when(r.createdAt) },
    { key: "action", header: t("action"), cell: (r) => r.action },
    { key: "target", header: t("target"), cell: (r) => `${r.targetType}${r.targetId ? ` ${r.targetId.slice(0, 8)}` : ""}` },
    { key: "actor", header: t("actor"), cell: (r) => r.actorAccountId?.slice(0, 8) ?? t("system") },
  ];
  return (
    <section>
      <H2>{t("title")}</H2>
      {error ? <p role="alert" className="mb-2 text-sm text-red-600">{error}</p> : null}
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} pagination={{ page, size: 20, hasMore: rows.length === 20, onPageChange: setPage }} />
    </section>
  );
}

interface Meter { used: number; limit: number | null; percent: number | null; full: boolean; over: boolean }
interface UsageData {
  limits: { maxAccounts: number | null; maxStorageMb: number | null };
  usage: { accounts: number; activeAccounts: number; libraryFiles: number; submissionFiles: number; storageMb: number };
  accountsMeter: Meter;
  storageMeter: Meter;
}

/** 租户"使用情况与配额"：账号数、存储用量，和平台设的上限（留空 = 不限）。 */
function QuotaPanel({ tenant, onClose }: { tenant: TenantRow; onClose: () => void }) {
  const t = useTranslations("pages.tenants");
  const [data, setData] = React.useState<UsageData | null>(null);
  const [accounts, setAccounts] = React.useState("");
  const [storage, setStorage] = React.useState("");
  const [msg, setMsg] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    const d = await bff<UsageData>(`tenants/${tenant.id}/usage`);
    setData(d);
    setAccounts(d.limits.maxAccounts === null ? "" : String(d.limits.maxAccounts));
    setStorage(d.limits.maxStorageMb === null ? "" : String(d.limits.maxStorageMb));
  }, [tenant.id]);
  React.useEffect(() => { void load().catch((e) => setMsg((e as Error).message)); }, [load]);
  if (!data) return <Modal title={t("quota")} onClose={onClose}><p className="text-sm text-muted">{msg ?? "…"}</p></Modal>;
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  async function save() {
    try {
      await bff(`tenants/${tenant.id}/quota`, { method: "PUT", body: { maxAccounts: num(accounts), maxStorageMb: num(storage) } });
      await load();
      setMsg(t("saved"));
    } catch (e) { setMsg((e as Error).message); }
  }
  const bar = (m: Meter) => (
    <div className="h-2 w-48 rounded bg-border" role="img" aria-label={m.percent === null ? t("noLimit") : `${m.percent}%`}>
      <div className={`h-2 rounded ${m.over ? "bg-red-500" : m.full ? "bg-amber-500" : "bg-primary"}`} style={{ width: `${Math.min(100, m.percent ?? 0)}%` }} />
    </div>
  );
  const u = data.usage;
  return (
    <Modal title={t("quotaOf", { name: tenant.name })} onClose={onClose}>
    <div className="text-sm">
      <div className="mb-3 grid gap-3 text-sm sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <span className="font-medium">{t("accountsUsed", { used: u.accounts, active: u.activeAccounts })}</span>
          {bar(data.accountsMeter)}
          <label className="flex flex-col gap-1">{t("maxAccounts")}
            <input type="number" min={1} className="w-32 rounded-md border border-border bg-transparent px-2 py-1" value={accounts} placeholder={t("noLimit")} onChange={(e) => setAccounts(e.target.value)} />
          </label>
        </div>
        <div className="flex flex-col gap-1">
          <span className="font-medium">{t("storageUsed", { mb: u.storageMb, library: u.libraryFiles, submissions: u.submissionFiles })}</span>
          {bar(data.storageMeter)}
          <label className="flex flex-col gap-1">{t("maxStorageMb")}
            <input type="number" min={1} className="w-32 rounded-md border border-border bg-transparent px-2 py-1" value={storage} placeholder={t("noLimit")} onChange={(e) => setStorage(e.target.value)} />
          </label>
        </div>
      </div>
      <p className="mb-2 text-xs text-muted">{t("quotaHelp")}</p>
      <div className="flex items-center gap-2 text-sm">
        <PermButton perm={PERMS.platformTenantQuota} size="sm" onClick={() => void save()}>{t("save")}</PermButton>
        <Button size="sm" variant="outline" onClick={onClose}>{t("close")}</Button>
        {msg ? <span role="status" className="text-muted">{msg}</span> : null}
      </div>
    </div>
    </Modal>
  );
}
