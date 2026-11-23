"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { PermRowAction, RowAction } from "../icon-button";
import { Undo2, Users } from "lucide-react";
import { PERMS } from "@staredu/shared";
import { Button } from "@/components/ui/button";
import { bff } from "@/lib/bff";
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
  return (
    <section className="text-sm">
      <h2 className="mb-3 text-lg font-semibold">{t("title")}</h2>
      {message}
      <ul className="mb-3 space-y-2">
        {list.rows.map((a) => (
          <li key={a.id} className="rounded-md border border-border p-2">
            <div className="font-medium">{a.title} <span className="text-muted">· {t(`aud_${a.scopeKind}`)} · {t("recipients", { n: a.recipients })}{a.withdrawnAt ? ` · ${t("withdrawn")}` : ""}</span></div>
            <div className="whitespace-pre-wrap">{a.body}</div>
            <div className="mt-1 flex gap-2">
              <RowAction onClick={() => void bff<Reader[]>(`announcements/${a.id}/readers`).then((rows) => setReaders({ id: a.id, rows }))} icon={Users}>{t("readers")}</RowAction>
              {a.withdrawnAt ? null : <PermRowAction perm={PERMS.msgAnnouncementRemove} onClick={() => void run(() => bff(`announcements/${a.id}`, { method: "DELETE" }), c("done"))} icon={Undo2}>{t("withdraw")}</PermRowAction>}
            </div>
            {readers?.id === a.id ? <ul className="mt-1 list-disc pl-5">{readers.rows.map((r) => <li key={r.accountId}>{r.username}: {r.readAt ? t("read") : t("unread")}</li>)}</ul> : null}
          </li>
        ))}
      </ul>
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
        ) : <Button size="sm" onClick={() => setCreating(true)}>{t("new")}</Button>}
      </Can>
    </section>
  );
}
