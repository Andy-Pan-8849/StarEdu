"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { Ban, Calculator, Download, FilePenLine, Pencil, RotateCcw, Send, X } from "lucide-react";
import { IconLink, PermRowAction } from "../icon-button";
import { PERMS } from "@staredu/shared";
import { bff } from "@/lib/bff";
import { usePromptDialog } from "../prompt-dialog";
import { Can, PermButton } from "../permissions";
import { useAct } from "./crud";
import { Modal } from "../modal";
import { Button } from "@/components/ui/button";
import { useList } from "./use-api";
import { useTable } from "./use-table";
import { DataTable, type Column } from "../data-table";

const H2 = ({ children }: { children: React.ReactNode }) => <h2 className="mb-3 text-lg font-semibold">{children}</h2>;
const input = "rounded-md border border-border bg-transparent px-2 py-1";

/** 等级表输入：每行"等级, 最低百分比, 绩点, 及格(y/n)"。 */
export function parseScale(text: string): Array<{ grade: string; minPercent: number; points: number; passing: boolean }> {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [grade, min, points, pass] = line.split(",").map((x) => x.trim());
      return { grade, minPercent: Number(min), points: Number(points), passing: /^(y|yes|true|1)$/i.test(pass ?? "") };
    });
}

async function downloadPdf(path: string, method: "GET" | "POST") {
  const res = await fetch(`/bff/${path}`, { method, credentials: "same-origin", headers: method === "POST" ? { "x-requested-with": "staredu" } : {} });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "transcript.pdf";
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------- 班级的"成绩"页签
interface Group { id: string; name: string; weight: number }
interface Book {
  groups: Group[];
  assignments: Array<{ id: string; title: string; maxScore: number; manualOnly: boolean; counted: boolean }>;
  problems: string[];
  pendingSubmissions: number;
  students: Array<{ enrollmentId: string; personId: string; fullName: string | null; studentNo: string | null; cells: Record<string, { points: number | null; state: string }>; total: number | null; grade: string | null; final: { total: number; grade: string; passed: boolean; published: boolean } | null }>;
}

export function GradesPanel({ sectionId }: { sectionId: string }) {
  const t = useTranslations("pages.grades");
  const c = useTranslations("crud");
  const [book, setBook] = React.useState<Book | null>(null);
  const load = React.useCallback(() => { void bff<Book>(`sections/${sectionId}/gradebook`).then(setBook); }, [sectionId]);
  React.useEffect(load, [load]);
  const { run, message } = useAct(load);
  const { ask, dialog } = usePromptDialog();
  const [weights, setWeights] = React.useState<Record<string, string>>({});
  React.useEffect(() => { if (book) setWeights(Object.fromEntries(book.groups.map((g) => [g.id, String(g.weight)]))); }, [book]);
  if (!book) return <p className="text-muted">…</p>;
  const base = `sections/${sectionId}`;
  async function manual(assignmentId: string, studentId: string) {
    const r = await ask(t("enterScore"), [{ name: "points", label: t("enterScore"), type: "number" }]);
    if (r === null) return;
    const v = r.points;
    await run(() => bff(`${base}/assignments/${assignmentId}/manual-scores/${studentId}`, { method: "PUT", body: { points: v.trim() === "" ? null : Number(v) } }), c("saved"));
  }
  async function amend(enrollmentId: string) {
    const v = await ask(t("newTotal"), [{ name: "total", label: t("newTotal"), type: "number" }, { name: "reason", label: t("reasonPrompt"), type: "textarea" }]);
    if (!v) return;
    const total = Number(v.total);
    const reason = v.reason;
    if (Number.isNaN(total) || reason.trim().length < 5) return;
    await run(() => bff(`${base}/final-grades/${enrollmentId}`, { method: "PUT", body: { total, reason } }), c("saved"));
  }
  return (
    <div>
      {message}
      {dialog}
      <h4 className="mb-1 font-medium">{t("policy")}</h4>
      <div className="mb-2 flex flex-wrap items-center gap-3">
        {book.groups.map((g) => (
          <label key={g.id} className="flex items-center gap-1">{g.name}
            <input type="number" min={0} max={100} step="0.01" className={`${input} w-20`} value={weights[g.id] ?? ""} onChange={(e) => setWeights({ ...weights, [g.id]: e.target.value })} />%</label>
        ))}
        <PermButton perm={PERMS.eduGradeEdit} size="sm" onClick={() => void run(() => bff(`${base}/grade-policy`, { method: "PUT", body: { groups: book.groups.map((g) => ({ id: g.id, weight: Number(weights[g.id] ?? 0) })) } }), c("saved"))}>{t("saveWeights")}</PermButton>
      </div>
      {book.problems.length ? <p role="alert" className="mb-2 text-amber-600">{book.problems.join("; ")}</p> : null}
      {book.pendingSubmissions ? <p className="mb-2 text-amber-600">{t("pending", { n: book.pendingSubmissions })}</p> : null}
      <div className="mb-2 flex flex-wrap gap-2">
        <PermButton perm={PERMS.eduGradeEdit} size="sm" onClick={() => void run(() => bff(`${base}/final-grades/calculate`, { method: "POST" }), c("done"))}>{t("calculate")}</PermButton>
        <PermRowAction perm={PERMS.eduGradeEdit} onClick={() => window.confirm(t("confirmPublish")) && void run(() => bff(`${base}/final-grades/publish`, { method: "POST" }), c("done"))} icon={Send}>{t("publishFinal")}</PermRowAction>
        <PermRowAction perm={PERMS.eduGradeAmend} onClick={() => void ask(t("recalculate"), [{ name: "reason", label: t("reasonPrompt"), type: "textarea" }]).then((v) => { if (v && v.reason.trim().length >= 5) void run(() => bff(`${base}/final-grades/recalculate`, { method: "POST", body: { reason: v.reason } }), c("done")); })} icon={Calculator}>{t("recalculate")}</PermRowAction>
        <Can perm={PERMS.eduGradeList}><IconLink icon={Download} label={t("exportCsv")} href={`/bff/${base}/gradebook.csv`}/></Can>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead className="text-muted">
            <tr><th className="py-1">{t("student")}</th>{book.assignments.map((a) => <th key={a.id}>{a.title} (/{a.maxScore}){a.counted ? "" : " *"}</th>)}<th>{t("total")}</th><th>{t("grade")}</th><th>{t("final")}</th><th /></tr>
          </thead>
          <tbody>
            {book.students.map((s) => (
              <tr key={s.enrollmentId} className="border-t border-border">
                <td className="py-1">{s.fullName} {s.studentNo ? `(${s.studentNo})` : ""}</td>
                {book.assignments.map((a) => {
                  const cell = s.cells[a.id];
                  return (
                    <td key={a.id}>
                      {cell.points ?? (cell.state === "missing" ? t("missing") : t("unpublished"))}
                      <PermButton perm={PERMS.eduGradeEdit} size="sm" variant="outline" className="ml-1" onClick={() => void manual(a.id, s.personId)}>✎</PermButton>
                    </td>
                  );
                })}
                <td>{s.total ?? ""}</td>
                <td>{s.grade ?? ""}</td>
                <td>{s.final ? `${s.final.grade} ${s.final.total} ${s.final.published ? t("published") : t("draft")}${s.final.passed ? "" : ` (${t("failed")})`}` : ""}</td>
                <td>{s.final ? <PermRowAction perm={PERMS.eduGradeAmend} onClick={() => void amend(s.enrollmentId)} icon={FilePenLine}>{t("amend")}</PermRowAction> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-xs text-muted">* {t("notCounted")}</p>
    </div>
  );
}

// ---------------------------------------------------------------- 成绩等级表
interface Scale { isDefault: boolean; items: Array<{ grade: string; minPercent: number; points: number; passing: boolean }> }

export function GradingScalePage() {
  const t = useTranslations("pages.grades");
  const c = useTranslations("crud");
  const [scale, setScale] = React.useState<Scale | null>(null);
  const [text, setText] = React.useState("");
  const load = React.useCallback(() => { void bff<Scale>("grading-scale").then((s) => { setScale(s); setText(s.items.map((i) => `${i.grade}, ${i.minPercent}, ${i.points}, ${i.passing ? "y" : "n"}`).join("\n")); }); }, []);
  React.useEffect(load, [load]);
  const { run, message } = useAct(load);
  const [editing, setEditing] = React.useState(false);
  const tbl = useTable();
  if (!scale) return <p className="text-sm text-muted">…</p>;
  const cols: Column<Scale["items"][number]>[] = [
    { key: "grade", header: t("scaleGrade"), cell: (i) => i.grade },
    { key: "min", header: t("scaleMin"), cell: (i) => `${i.minPercent}%` },
    { key: "points", header: t("scalePoints"), cell: (i) => i.points },
    { key: "pass", header: t("scalePass"), cell: (i) => (i.passing ? c("yes") : c("no")) },
  ];
  return (
    <section className="text-sm">
      <H2>{t("scaleTitle")}</H2>
      <p className="mb-2 text-muted">{scale.isDefault ? t("scaleDefault") : t("scaleCustom")}</p>
      {message}
      <div className="mb-3 flex gap-2">
        <PermRowAction perm={PERMS.eduScaleEdit} onClick={() => setEditing(true)} icon={Pencil}>{c("edit")}</PermRowAction>
        <PermRowAction perm={PERMS.eduScaleEdit} onClick={() => window.confirm(t("confirmReset")) && void run(() => bff("grading-scale/reset", { method: "POST" }), c("done"))} icon={RotateCcw}>{t("resetDefault")}</PermRowAction>
      </div>
      <DataTable columns={cols} rows={scale.items} rowKey={(i) => i.grade} emptyText={tbl.empty} loadingText={tbl.loading} selectable={false} labels={tbl.labels} />
      {editing ? (
        <Modal title={t("scaleTitle")} onClose={() => setEditing(false)}>
          <div className="flex flex-col gap-3 text-sm">
            <p className="text-muted">{t("scaleHelp")}</p>
            <textarea aria-label={t("scaleTitle")} className={`${input} w-full font-mono`} rows={8} value={text} onChange={(e) => setText(e.target.value)} />
            <div className="flex gap-2 border-t border-border pt-3">
              <PermButton perm={PERMS.eduScaleEdit} size="sm" onClick={() => void run(() => bff("grading-scale", { method: "PUT", body: { items: parseScale(text) } }), c("saved")).then((ok) => { if (ok) setEditing(false); })}>{c("save")}</PermButton>
              <Button size="sm" variant="outline" onClick={() => { setEditing(false); load(); }}>{c("cancel")}</Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- 成绩单（教务）
interface TranscriptView { transcript: { student: { fullName: string; studentNo: string | null }; terms: Array<{ termId: string; name: string; gpa: number | null; rows: Array<{ enrollmentId: string; courseCode: string; courseName: string; state: string; grade: string | null; total: number | null; replaced: boolean }> }>; cumulative: { gpa: number | null; creditsAttempted: number; creditsEarned: number } }; issues: Array<{ id: string; docNumber: string; version: string; generatedAt: string; verifyUrl: string; verifiable: boolean; revokedAt: string | null; revokeReason: string | null }> }

export function TranscriptsPage() {
  const t = useTranslations("pages.grades");
  const students = useList<{ id: string; fullName: string; studentNo: string | null }>("students?size=100");
  const [view, setView] = React.useState<TranscriptView | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [current, setCurrent] = React.useState<string | null>(null);
  const [revoking, setRevoking] = React.useState<string | null>(null);
  const [revokeReason, setRevokeReason] = React.useState("");
  const open = React.useCallback((id: string) => { setCurrent(id); void bff<TranscriptView>(`transcripts/${id}`).then(setView).catch((e: Error) => setMsg(e.message)); }, []);
  return (
    <section className="text-sm">
      <H2>{t("transcriptsTitle")}</H2>
      <select aria-label={t("pickStudent")} className={`${input} mb-3`} value={current ?? ""} onChange={(e) => e.target.value && open(e.target.value)}>
        <option value="">{t("pickStudent")}</option>
        {students.rows.map((s) => <option key={s.id} value={s.id}>{s.fullName} ({s.studentNo})</option>)}
      </select>
      {msg ? <p role="alert" className="mb-2 text-red-600">{msg}</p> : null}
      {view ? (
        <div>
          {view.transcript.terms.map((term) => (
            <div key={term.termId} className="mb-2">
              <div className="font-medium">{term.name} — GPA {term.gpa ?? "-"}</div>
              <ul className="list-disc pl-5">{term.rows.map((r) => <li key={r.enrollmentId}>{r.courseCode} {r.courseName}: {r.state === "graded" ? `${r.grade} (${r.total})${r.replaced ? ` · ${t("retaken")}` : ""}` : t(`state_${r.state}`)}</li>)}</ul>
            </div>
          ))}
          <p className="mb-2">{t("cumulative")}: GPA {view.transcript.cumulative.gpa ?? "-"} · {t("credits", { a: view.transcript.cumulative.creditsAttempted, e: view.transcript.cumulative.creditsEarned })}</p>
          <PermButton perm={PERMS.eduTranscriptIssue} size="sm" onClick={() => void downloadPdf(`transcripts/${current}/formal`, "POST").then(() => open(current!)).catch((e: Error) => setMsg(e.message))}>{t("issueFormal")}</PermButton>
          <ul className="mt-2 text-muted">{view.issues.map((i) => (
            <li key={i.id}>
              {i.docNumber} · {t(`v_${i.version}`)} · {new Date(i.generatedAt).toLocaleString()} ·{" "}
              <a className="underline" href={i.verifyUrl} target="_blank" rel="noreferrer">{t("verifyLink")}</a>
              {i.revokedAt ? <span className="ml-2 text-red-600">{t("revoked")}{i.revokeReason ? `: ${i.revokeReason}` : ""}</span> : (
                revoking === i.id ? (
                  <span className="ml-2 inline-flex items-center gap-1">
                    <input aria-label={t("revokeReason")} placeholder={t("revokeReason")} className={`${input} w-80`} value={revokeReason} onChange={(e) => setRevokeReason(e.target.value)} />
                    <PermButton perm={PERMS.eduTranscriptIssue} size="sm" disabled={!revokeReason.trim()} onClick={() => void bff(`transcripts/issues/${i.id}/revoke`, { method: "POST", body: { reason: revokeReason.trim() } }).then(() => { setRevoking(null); open(current!); }).catch((e: Error) => setMsg(e.message))}>{t("revoke")}</PermButton>
                    <PermRowAction perm={PERMS.eduTranscriptIssue} onClick={() => setRevoking(null)} icon={X}>{t("cancel")}</PermRowAction>
                  </span>
                ) : (
                  <PermRowAction perm={PERMS.eduTranscriptIssue} className="ml-2" onClick={() => { setRevoking(i.id); setRevokeReason(""); }} icon={Ban} danger>{t("revoke")}</PermRowAction>
                )
              )}
            </li>
          ))}</ul>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- 仪表板
interface Overview { campuses: Array<{ campusId: string; campus: string; sections: number; inProgressSections: number; students: number; completionRate: number | null; averageScore: number | null; lateRate: number | null }>; totals: { sections: number; inProgressSections: number; students: number } }

export function DashboardPage() {
  const t = useTranslations("pages.grades");
  const [o, setO] = React.useState<Overview | null>(null);
  React.useEffect(() => { void bff<Overview>("dashboard/overview").then(setO); }, []);
  if (!o) return <p className="text-sm text-muted">…</p>;
  const pct = (v: number | null) => (v === null ? "-" : `${v}%`);
  return (
    <section className="text-sm">
      <H2>{t("dashboardTitle")}</H2>
      <p className="mb-3">{t("totals", { s: o.totals.sections, p: o.totals.inProgressSections, n: o.totals.students })}</p>
      <table className="w-full text-left">
        <thead className="text-muted"><tr><th className="py-1">{t("campus")}</th><th>{t("students")}</th><th>{t("sections")}</th><th>{t("completion")}</th><th>{t("average")}</th><th>{t("lateRate")}</th></tr></thead>
        <tbody>{o.campuses.map((c) => <tr key={c.campusId} className="border-t border-border"><td className="py-1">{c.campus}</td><td>{c.students}</td><td>{c.inProgressSections}/{c.sections}</td><td>{pct(c.completionRate)}</td><td>{pct(c.averageScore)}</td><td>{pct(c.lateRate)}</td></tr>)}</tbody>
      </table>
    </section>
  );
}

// ---------------------------------------------------------------- 学生门户：我的成绩
interface MyGrades { student: { fullName: string }; terms: Array<{ termId: string; name: string; gpa: number | null; rows: Array<{ enrollmentId: string; courseCode: string; courseName: string; credits: number; state: string; grade: string | null; total: number | null; replaced: boolean }> }>; cumulative: { gpa: number | null; creditsAttempted: number; creditsEarned: number }; progress: { creditsEarned: number; creditsRequired: number | null } }

export function PortalGradesPage() {
  const t = useTranslations("pages.grades");
  const tbl = useTable();
  const [g, setG] = React.useState<MyGrades | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  React.useEffect(() => { void bff<MyGrades>("grades").then(setG); }, []);
  if (!g) return <p className="text-sm text-muted">…</p>;
  return (
    <section className="text-sm">
      <H2>{t("myGrades")}</H2>
      <p className="mb-2">{t("cumulative")}: GPA {g.cumulative.gpa ?? "-"} · {t("credits", { a: g.cumulative.creditsAttempted, e: g.cumulative.creditsEarned })}{g.progress.creditsRequired ? ` · ${t("progress", { e: g.progress.creditsEarned, r: g.progress.creditsRequired })}` : ""}</p>
      {err ? <p role="alert" className="mb-2 text-red-600">{err}</p> : null}
      <div className="mb-3"><PermRowAction perm={PERMS.portalTranscriptDownload} icon={Download} onClick={() => void downloadPdf("transcript.pdf", "GET").catch((e: Error) => setErr(e.message))}>{t("downloadTranscript")}</PermRowAction></div>
      {g.terms.map((term) => (
        <div key={term.termId} className="mb-4">
          <h3 className="mb-1 font-medium">{term.name} — GPA {term.gpa ?? "-"}</h3>
          <DataTable
            columns={[
              { key: "code", header: t("colCode"), cell: (r) => r.courseCode },
              { key: "name", header: t("colCourse"), cell: (r) => r.courseName },
              { key: "credits", header: t("colCredits"), cell: (r) => r.credits },
              { key: "result", header: t("colResult"), cell: (r) => (r.state === "graded" ? `${r.grade} (${r.total})${r.replaced ? ` · ${t("retaken")}` : ""}` : t(`state_${r.state}`)) },
            ] as Column<MyGrades["terms"][number]["rows"][number]>[]}
            rows={term.rows}
            rowKey={(r) => r.enrollmentId}
            emptyText={tbl.empty}
            loadingText={tbl.loading}
            selectable={false}
            labels={tbl.labels}
          />
        </div>
      ))}
      <p className="text-xs text-muted">{t("unofficialNote")}</p>
    </section>
  );
}
