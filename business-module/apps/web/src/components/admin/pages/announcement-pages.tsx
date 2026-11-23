"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { IconButton, PermRowAction, RowAction } from "../icon-button";
import { Plus, Undo2, Users } from "lucide-react";
import { PERMS } from "@staredu/shared";
import { bff } from "@/lib/bff";
import { DataTable, type Column } from "../data-table";
import { Modal } from "../modal";
import { Can } from "../permissions";
import { FormPanel, useAct } from "./crud";
import { useList } from "./use-api";

interface Row { id: string; title: string; body: string; scopeKind: string; recipients: number; createdAt: string; withdrawnAt: string | null }
interface Reader { accountId: string; username: string | null; readAt: string | null }

export function AnnouncementsPage() {
  const t = useTranslations("pages.announcements");
  const c = useTranslations("crud");
  const list = useList<Row>("announcements");
  const campuses = useList<{ id: string; name: string }>("campuses");
  const sections = useList<{ id: string; name: string }>("sections");
  const { run, message } = useAct(list.reload);
  const [creating, setCreating] = React.useState(false);
  const [readers, setReaders] = React.useState<{ id: string; rows: Reader[] } | null>(null);
  const [kind, setKind] = React.useState<"tenant" | "campus" | "section">("tenant");
  const [pick, setPick] = React.useState("");
  const options = kind === "campus" ? campuses.rows : kind === "section" ? sections.rows : [];
  const tt = useTranslations("table");
  const columns: Column<Row>[] = [
    { key: "title", header: t("titleField"), cell: (a) => <div className="max-w-md"><div className="font-medium">{a.title}</div><div className="line-clamp-2 whitespace-pre-wrap text-muted">{a.body}</div></div> },
    { key: "aud", header: t("audience"), cell: (a) => t(`aud_${a.scopeKind}`) },
    { key: "rec", header: t("recipientsCol"), cell: (a) => a.recipients },
    { key: "at", header: t("createdCol"), cell: (a) => new Date(a.createdAt).toLocaleString() },
    { key: "state", header: t("stateCol"), cell: (a) => (a.withdrawnAt ? t("withdrawn") : t("published")) },
    {
      key: "actions",
      header: "",
      cell: (a) => (
        <>
          <RowAction onClick={() => void bff<Reader[]>(`announcements/${a.id}/readers`).then((rows) => setReaders({ id: a.id, rows }))} icon={Users}>{t("readers")}</RowAction>
          {a.withdrawnAt ? null : <PermRowAction perm={PERMS.msgAnnouncementRemove} onClick={() => void run(() => bff(`announcements/${a.id}`, { method: "DELETE" }), c("done"))} icon={Undo2}>{t("withdraw")}</PermRowAction>}
        </>
      ),
    },
  ];
  return (
    <section className="text-sm">
      <h2 className="mb-3 text-lg font-semibold">{t("title")}</h2>
      {message}
      <div className="mb-3">
        <Can perm={PERMS.msgAnnouncementAdd}><IconButton icon={Plus} label={t("new")} onClick={() => setCreating(true)} /></Can>
      </div>
      <DataTable
        columns={columns}
        rows={list.rows}
        rowKey={(r) => r.id}
        loading={list.loading}
        emptyText={tt("empty")}
        loadingText={tt("loading")}
        labels={{ actions: tt("actions"), more: tt("more"), selectAll: tt("selectAll"), selectRow: tt("selectRow"), clearSelection: tt("clearSelection"), selected: (n: number) => tt("selected", { n }), previous: tt("previous"), next: tt("next"), page: (p: number, n: number) => tt("page", { page: p, pages: n }) }}
      />
      {readers ? (
        <Modal title={t("readers")} onClose={() => setReaders(null)}>
          <ul className="list-disc pl-5 text-sm">{readers.rows.map((r) => <li key={r.accountId}>{r.username}: {r.readAt ? t("read") : t("unread")}</li>)}</ul>
        </Modal>
      ) : null}
      <Can perm={PERMS.msgAnnouncementAdd}>
        {creating ? (
          <Modal title={t("new")} onClose={() => setCreating(false)}>
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <label className="flex items-center gap-1">{t("audience")}
                <select className="rounded-md border border-border bg-transparent px-2 py-1" value={kind} onChange={(e) => { setKind(e.target.value as typeof kind); setPick(""); }}>
                  <option value="tenant">{t("aud_tenant")}</option><option value="campus">{t("aud_campus")}</option><option value="section">{t("aud_section")}</option>
                </select></label>
              {kind !== "tenant" ? <select aria-label={t("pick")} className="rounded-md border border-border bg-transparent px-2 py-1" value={pick} onChange={(e) => setPick(e.target.value)}><option value="">{t("pick")}</option>{options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select> : null}
            </div>
            <FormPanel
              inline
              title={t("new")}
              fields={[{ name: "title", label: t("titleField"), required: true }, { name: "body", label: t("bodyField"), type: "textarea", required: true }]}
              submitLabel={t("publish")}
              cancelLabel={c("cancel")}
              onCancel={() => setCreating(false)}
              onSubmit={async (p) => {
                const target = kind === "tenant" ? { kind } : kind === "campus" ? { kind, campusId: pick } : { kind, sectionId: pick };
                if (await run(() => bff("announcements", { method: "POST", body: { ...p, target } }), c("done"))) setCreating(false);
              }}
            />
          </div>
          </Modal>
        ) : null}
      </Can>
    </section>
  );
}
