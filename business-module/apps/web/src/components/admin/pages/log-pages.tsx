"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { PERMS } from "@staredu/shared";
import { bff } from "@/lib/bff";
import { DataTable, type Column } from "../data-table";
import { PermButton } from "../permissions";
import { useList } from "./use-api";

const SIZE = 20;
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "");

function useTableLabels() {
  const t = useTranslations("table");
  return { empty: t("empty"), loading: t("loading"), labels: { actions: t("actions"), selectAll: t("selectAll"), selectRow: t("selectRow"), clearSelection: t("clearSelection"), selected: (n: number) => t("selected", { n }), previous: t("previous"), next: t("next"), page: (p: number, n: number) => t("page", { page: p, pages: n }) } };
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 text-lg font-semibold">{children}</h2>;
}

interface OnlineRow {
  sid: string;
  username: string;
  entry?: string;
  ip?: string;
  loginAt: string;
  lastSeen: string;
}

export function OnlineUsersPage() {
  const t = useTranslations("pages.online");
  const tt = useTableLabels();
  const { rows, loading, error, reload } = useList<OnlineRow>("online");
  const [message, setMessage] = React.useState<string | null>(null);
  const columns: Column<OnlineRow>[] = [
    { key: "username", header: t("username"), cell: (r) => r.username },
    { key: "entry", header: t("entry"), cell: (r) => r.entry ?? "" },
    { key: "ip", header: t("ip"), cell: (r) => r.ip ?? "" },
    { key: "loginAt", header: t("loginAt"), cell: (r) => when(r.loginAt) },
    { key: "lastSeen", header: t("lastSeen"), cell: (r) => when(r.lastSeen) },
    {
      key: "actions",
      header: "",
      cell: (r) => (
        <PermButton
          perm={PERMS.onlineForceLogout}
          size="sm"
          variant="outline"
          onClick={async () => {
            if (!window.confirm(t("confirm", { name: r.username }))) return;
            try {
              await bff(`online/${encodeURIComponent(r.sid)}`, { method: "DELETE" });
              setMessage(t("done", { name: r.username }));
            } catch (e) {
              setMessage((e as Error).message);
            }
            reload();
          }}
        >
          {t("forceLogout")}
        </PermButton>
      ),
    },
  ];
  return (
    <section>
      <Heading>{t("title")}</Heading>
      {error ? <p role="alert" className="mb-2 text-sm text-red-600">{error}</p> : null}
      {message ? <p role="status" className="mb-2 text-sm text-muted">{message}</p> : null}
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.sid} loading={loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
    </section>
  );
}

function usePaged<T>(path: string) {
  const [page, setPage] = React.useState(1);
  const list = useList<T>(`${path}?page=${page}&size=${SIZE}`);
  return { ...list, pagination: { page, size: SIZE, hasMore: list.rows.length === SIZE, onPageChange: setPage } };
}

interface LoginRow {
  id: string;
  username: string | null;
  entry: string;
  result: string;
  reason: string | null;
  ip: string | null;
  createdAt: string;
}

export function LoginLogPage() {
  const t = useTranslations("pages.loginLog");
  const tt = useTableLabels();
  const { rows, loading, error, pagination } = usePaged<LoginRow>("login-logs");
  const columns: Column<LoginRow>[] = [
    { key: "createdAt", header: t("time"), cell: (r) => when(r.createdAt) },
    { key: "username", header: t("username"), cell: (r) => r.username ?? "" },
    { key: "entry", header: t("entry"), cell: (r) => r.entry },
    { key: "result", header: t("result"), cell: (r) => (r.result === "success" ? t("success") : t("denied")) },
    { key: "reason", header: t("reason"), cell: (r) => r.reason ?? "" },
    { key: "ip", header: t("ip"), cell: (r) => r.ip ?? "" },
  ];
  return (
    <section>
      <Heading>{t("title")}</Heading>
      {error ? <p role="alert" className="mb-2 text-sm text-red-600">{error}</p> : null}
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} pagination={pagination} />
    </section>
  );
}

interface AuditRow {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  actorAccountId: string | null;
  createdAt: string;
}

export function AuditLogPage() {
  const t = useTranslations("pages.auditLog");
  const tt = useTableLabels();
  const { rows, loading, error, pagination } = usePaged<AuditRow>("audit-logs");
  const columns: Column<AuditRow>[] = [
    { key: "createdAt", header: t("time"), cell: (r) => when(r.createdAt) },
    { key: "action", header: t("action"), cell: (r) => r.action },
    { key: "target", header: t("target"), cell: (r) => `${r.targetType}${r.targetId ? ` ${r.targetId.slice(0, 8)}` : ""}` },
    { key: "actor", header: t("actor"), cell: (r) => r.actorAccountId?.slice(0, 8) ?? "" },
  ];
  return (
    <section>
      <Heading>{t("title")}</Heading>
      {error ? <p role="alert" className="mb-2 text-sm text-red-600">{error}</p> : null}
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} pagination={pagination} />
    </section>
  );
}
