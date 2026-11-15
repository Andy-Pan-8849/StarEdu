"use client";

// 学生申请：学生门户（提交、撤回）和管理后台（看、批准、驳回）。
import { useTranslations } from "next-intl";
import * as React from "react";
import { PERMS } from "@staredu/shared";
import { bff } from "@/lib/bff";
import { Can, PermButton } from "../permissions";
import { useAct } from "./crud";
import { useList } from "./use-api";

const H2 = ({ children }: { children: React.ReactNode }) => <h2 className="mb-3 text-lg font-semibold">{children}</h2>;
const input = "rounded-md border border-border bg-transparent px-2 py-1";

interface MyRequest { id: string; kind: "grade_appeal" | "extension"; status: string; section: string; assignment: string | null; days: number | null; reason: string; decisionNote: string | null; createdAt: string }
interface Options {
  appeals: Array<{ enrollmentId: string; section: string; total: number; grade: string; closesAt: string }>;
  extensions: Array<{ assignmentId: string; title: string; section: string; dueAt: string; currentDays: number }>;
  appealWindowDays: number;
}

// ---------------------------------------------------------------- 学生门户：我的申请
export function PortalRequestsPage() {
  const t = useTranslations("pages.requests");
  const list = useList<MyRequest>("requests");
  const [opts, setOpts] = React.useState<Options | null>(null);
  const loadOpts = React.useCallback(() => { void bff<Options>("requests/options").then(setOpts); }, []);
  React.useEffect(loadOpts, [loadOpts]);
  const reload = React.useCallback(() => { list.reload(); loadOpts(); }, [list, loadOpts]);
  const { message, run } = useAct(reload);
  const [target, setTarget] = React.useState("");
  const [days, setDays] = React.useState("1");
  const [reason, setReason] = React.useState("");

  const submit = async () => {
    const [kind, id] = target.split(":");
    if (!id) return;
    const body = kind === "appeal" ? { kind: "grade_appeal", enrollmentId: id, reason } : { kind: "extension", assignmentId: id, days: Number(days), reason };
    if (await run(() => bff("requests", { method: "POST", body }), t("submitted"))) { setTarget(""); setReason(""); }
  };

  return (
    <section className="text-sm">
      <H2>{t("myTitle")}</H2>
      <Can perm={PERMS.portalRequestSubmit}>
        <div className="mb-4 flex flex-col gap-2 rounded-md border border-border p-3">
          <select aria-label={t("pick")} className={input} value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">{t("pick")}</option>
            {opts?.appeals.map((a) => <option key={a.enrollmentId} value={`appeal:${a.enrollmentId}`}>{t("appealOption", { section: a.section, grade: a.grade, total: a.total })}</option>)}
            {opts?.extensions.map((x) => <option key={x.assignmentId} value={`extension:${x.assignmentId}`}>{t("extensionOption", { section: x.section, title: x.title, due: new Date(x.dueAt).toLocaleString() })}</option>)}
          </select>
          {target.startsWith("extension:") ? (
            <label className="flex items-center gap-2">{t("days")}
              <select className={input} value={days} onChange={(e) => setDays(e.target.value)}>{[1, 2, 3].map((d) => <option key={d} value={d}>{d}</option>)}</select>
            </label>
          ) : null}
          <textarea aria-label={t("reason")} placeholder={t("reason")} className={input} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          <p className="text-xs text-muted">{t("windowNote", { days: opts?.appealWindowDays ?? 14 })}</p>
          <div><PermButton perm={PERMS.portalRequestSubmit} size="sm" disabled={!target || reason.trim().length < 3} onClick={() => void submit()}>{t("submit")}</PermButton></div>
        </div>
      </Can>
      {message}
      {list.rows.length === 0 ? <p className="text-muted">{t("none")}</p> : (
        <ul className="flex flex-col gap-2">
          {list.rows.map((r) => (
            <li key={r.id} className="rounded-md border border-border p-2">
              <div className="font-medium">{t(`kind_${r.kind}`)} · {r.section}{r.assignment ? ` · ${r.assignment}` : ""}{r.days ? ` · ${t("daysN", { n: r.days })}` : ""}</div>
              <div className="text-muted">{t(`status_${r.status}`)} · {new Date(r.createdAt).toLocaleString()}</div>
              <div>{r.reason}</div>
              {r.decisionNote ? <div className="text-muted">{t("note")}: {r.decisionNote}</div> : null}
              {r.status === "pending" ? <PermButton perm={PERMS.portalRequestSubmit} size="sm" variant="outline" className="mt-1" onClick={() => void run(() => bff(`requests/${r.id}/withdraw`, { method: "POST" }))}>{t("withdraw")}</PermButton> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- 管理后台：学生申请
interface StaffRequest { id: string; kind: "grade_appeal" | "extension"; status: string; section: string; student: string; assignment: { title: string; dueAt: string } | null; days: number | null; currentGrade: { total: number; grade: string } | null; reason: string; decisionNote: string | null; result: { before?: { total: number }; after?: { total: number }; days?: number } | null; createdAt: string }

export function RequestsPage() {
  const t = useTranslations("pages.requests");
  const [status, setStatus] = React.useState("pending");
  const list = useList<StaffRequest>(`requests?status=${status}`);
  const { message, run } = useAct(list.reload);

  const decide = (r: StaffRequest, decision: "approve" | "reject") => {
    const note = window.prompt(t(decision === "approve" ? "approveNote" : "rejectNote"));
    if (!note || !note.trim()) return;
    const body: Record<string, unknown> = { decision, note: note.trim() };
    if (decision === "approve" && r.kind === "grade_appeal") {
      const total = window.prompt(t("newTotal", { current: r.currentGrade?.total ?? "-" }));
      if (total === null || total.trim() === "" || Number.isNaN(Number(total))) return;
      body.total = Number(total);
    }
    if (decision === "approve" && r.kind === "extension") {
      const d = window.prompt(t("approveDays"), String(r.days ?? 1));
      if (d === null || !/^[1-3]$/.test(d.trim())) return;
      body.days = Number(d);
    }
    void run(() => bff(`requests/${r.id}/decide`, { method: "POST", body }), t("decided"));
  };

  return (
    <section className="text-sm">
      <H2>{t("staffTitle")}</H2>
      <div role="tablist" className="mb-3 flex gap-3">
        {["pending", "approved", "rejected", "withdrawn"].map((s) => <button key={s} role="tab" aria-selected={status === s} className={status === s ? "font-medium underline" : "text-muted"} onClick={() => setStatus(s)}>{t(`status_${s}`)}</button>)}
      </div>
      {message}
      {list.rows.length === 0 ? <p className="text-muted">{t("none")}</p> : (
        <ul className="flex flex-col gap-2">
          {list.rows.map((r) => (
            <li key={r.id} className="rounded-md border border-border p-2">
              <div className="font-medium">{r.student} · {r.section} · {t(`kind_${r.kind}`)}</div>
              {r.kind === "extension" && r.assignment ? <div>{r.assignment.title} · {t("due", { at: new Date(r.assignment.dueAt).toLocaleString() })} · {t("daysN", { n: r.days ?? 0 })}</div> : null}
              {r.kind === "grade_appeal" && r.currentGrade ? <div>{t("currentGrade", { grade: r.currentGrade.grade, total: r.currentGrade.total })}</div> : null}
              <div>{r.reason}</div>
              {r.decisionNote ? <div className="text-muted">{t("note")}: {r.decisionNote}</div> : null}
              {r.result?.before ? <div className="text-muted">{t("changed", { a: r.result.before.total, b: r.result.after?.total ?? "-" })}</div> : null}
              {r.status === "pending" ? (
                <div className="mt-1 flex gap-2">
                  <PermButton perm={PERMS.eduRequestDecide} size="sm" onClick={() => decide(r, "approve")}>{t("approve")}</PermButton>
                  <PermButton perm={PERMS.eduRequestDecide} size="sm" variant="outline" onClick={() => decide(r, "reject")}>{t("reject")}</PermButton>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
