"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { IconButton, PermRowAction, RowAction } from "../icon-button";
import { ArrowLeft, CalendarPlus, ExternalLink, Eye, Inbox, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { PERMS } from "@staredu/shared";
import { Button } from "@/components/ui/button";
import { bff } from "@/lib/bff";
import { usePromptDialog } from "../prompt-dialog";
import { Can, PermButton } from "../permissions";
import { FormPanel, useAct } from "./crud";
import { useList } from "./use-api";
import { useTable } from "./use-table";
import { DataTable, type Column } from "../data-table";
import { Modal } from "../modal";

const H2 = ({ children }: { children: React.ReactNode }) => <h2 className="mb-3 text-lg font-semibold">{children}</h2>;
const input = "rounded-md border border-border bg-transparent px-2 py-1";

/** 评分标准输入：每行"标题: 分值"。 */
export function parseRubric(text: string): Array<{ title: string; maxPoints: number }> {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.lastIndexOf(":");
      return { title: (i < 0 ? line : line.slice(0, i)).trim(), maxPoints: Number(i < 0 ? NaN : line.slice(i + 1)) };
    });
}

// ---------------------------------------------------------------- 管理后台：班级的"作业"页签
interface Rubric { id: string; title: string; maxPoints: number }
interface Asg { id: string; title: string; description: string; allowLate: boolean; dueDate: string; published: boolean; maxScore: number; group: { name: string } | null; rubric: Rubric[]; counts: { submitted: number; grading: number; published: number } }
interface SubRow { studentPersonId: string; fullName: string | null; studentNo: string | null; submissionId: string | null; status: string; submittedAt: string | null; isLate: boolean; hoursLate: number; latePenaltyPct: number | null; rawScore: number | null; finalScore: number | null; extension: { days: number; reason: string } | null }
interface SubDetail { id: string; fullName: string | null; status: string; feedback: string | null; rawScore: number | null; finalScore: number | null; latePenaltyPct: number | null; versions: Array<{ version: number; textAnswer: string | null; submittedAt: string; isLate: boolean; files: Array<{ id: string; fileName: string; size: number; downloadUrl: string }> }>; scores: Array<{ rubricItemId: string; points: number }> }

/** 评分标准输入框里的文字：每行"标题: 分值"（parseRubric 的反向）。 */
export const rubricText = (r: Rubric[]) => r.map((x) => `${x.title}: ${x.maxPoints}`).join("\n");

export function AssignmentsPanel({ sectionId }: { sectionId: string }) {
  const t = useTranslations("pages.assignments");
  const c = useTranslations("crud");
  const tbl = useTable();
  const list = useList<Asg>(`sections/${sectionId}/assignments`);
  const { run, message } = useAct(list.reload);
  const [form, setForm] = React.useState<{ mode: "create" | "edit" | "view"; row: Asg | null } | null>(null);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const open = list.rows.find((a) => a.id === openId) ?? null;
  const columns: Column<Asg>[] = [
    { key: "title", header: t("title"), cell: (a) => <button type="button" className="text-left font-medium text-primary hover:underline" onClick={() => setForm({ mode: "view", row: a })}>{a.title}</button> },
    { key: "due", header: t("dueCol"), cell: (a) => a.dueDate },
    { key: "max", header: t("maxCol"), cell: (a) => a.maxScore },
    { key: "counts", header: t("countsCol"), cell: (a) => t("counts", { s: a.counts.submitted, g: a.counts.grading, p: a.counts.published }) },
    { key: "status", header: t("status"), cell: (a) => (a.published ? t("published") : <span className="text-muted">{t("draft")}</span>) },
    {
      key: "actions",
      header: "",
      cell: (a) => (
        <div className="flex flex-wrap gap-1">
          <RowAction onClick={() => setForm({ mode: "view", row: a })} icon={Eye}>{t("detail")}</RowAction>
          <PermRowAction perm={PERMS.eduAssignmentEdit} onClick={() => setForm({ mode: "edit", row: a })} icon={Pencil}>{c("edit")}</PermRowAction>
          <RowAction onClick={() => setOpenId(a.id)} icon={Inbox}>{t("submissions")}</RowAction>
          <PermRowAction perm={PERMS.eduAssignmentEdit} onClick={() => void run(() => bff(`sections/${sectionId}/assignments/${a.id}/publish`, { method: "POST", body: { published: !a.published } }), c("done"))} icon={Send}>{a.published ? t("unpublish") : t("publish")}</PermRowAction>
          <PermRowAction perm={PERMS.eduAssignmentEdit} onClick={() => window.confirm(c("confirmDelete", { name: a.title })) && void run(() => bff(`sections/${sectionId}/assignments/${a.id}`, { method: "DELETE" }), c("done"))} icon={Trash2} danger>{c("delete")}</PermRowAction>
        </div>
      ),
    },
  ];
  return (
    <div>
      {message}
      {open ? (
        <SubmissionsView sectionId={sectionId} assignment={open} onBack={() => { setOpenId(null); list.reload(); }} />
      ) : (
        <>
          <Can perm={PERMS.eduAssignmentEdit}>
            <div className="mb-2"><IconButton icon={Plus} label={t("newAssignment")} onClick={() => setForm({ mode: "create", row: null })} /></div>
          </Can>
          <DataTable columns={columns} rows={list.rows} rowKey={(a) => a.id} loading={list.loading} emptyText={t("empty")} loadingText={tbl.loading} selectable={false} maxActions={5} labels={tbl.labels} />
          {form?.mode === "view" && form.row ? (
            <Modal title={form.row.title} onClose={() => setForm(null)} closeLabel={c("close")}>
              <dl className="flex flex-col gap-3 text-sm">
                <div><dt className="text-muted">{t("status")}</dt><dd>{form.row.published ? t("published") : t("draft")}</dd></div>
                <div><dt className="text-muted">{t("dueCol")}</dt><dd>{form.row.dueDate}{form.row.group ? ` · ${form.row.group.name}` : ""}</dd></div>
                <div><dt className="text-muted">{t("maxCol")}</dt><dd>{form.row.maxScore}</dd></div>
                <div><dt className="text-muted">{t("allowLate")}</dt><dd>{form.row.allowLate ? c("yes") : c("no")}</dd></div>
                <div><dt className="text-muted">{t("description")}</dt><dd className="whitespace-pre-wrap">{form.row.description || "—"}</dd></div>
                <div><dt className="text-muted">{t("rubric")}</dt><dd>{form.row.rubric.length ? <ul className="list-disc pl-5">{form.row.rubric.map((r) => <li key={r.id}>{r.title} — {r.maxPoints}</li>)}</ul> : "—"}</dd></div>
              </dl>
              <div className="mt-4"><Button size="sm" variant="outline" onClick={() => setForm(null)}>{c("close")}</Button></div>
            </Modal>
          ) : null}
          {form && form.mode !== "view" ? (
            <FormPanel
              key={form.row?.id ?? "new"}
              title={form.row ? t("editAssignment") : t("newAssignment")}
              fields={[
                { name: "title", label: t("title"), required: true },
                { name: "dueDate", label: t("dueDateField"), required: true },
                { name: "description", label: t("description"), type: "textarea" },
                { name: "rubric", label: t("rubricField"), type: "textarea", required: true },
                { name: "allowLate", label: t("allowLate"), type: "checkbox" },
              ]}
              initial={form.row ? { title: form.row.title, dueDate: form.row.dueDate, description: form.row.description, rubric: rubricText(form.row.rubric), allowLate: form.row.allowLate } : { allowLate: true, rubric: "Correctness: 6\nStyle: 4" }}
              submitLabel={c("save")}
              cancelLabel={c("cancel")}
              onCancel={() => setForm(null)}
              onSubmit={async (p) => {
                const rubric = parseRubric(String(p.rubric ?? ""));
                const row = form.row;
                const ok = await run(async () => {
                  if (!row) { await bff(`sections/${sectionId}/assignments`, { method: "POST", body: { ...p, rubric } }); return; }
                  const { rubric: _text, ...rest } = p;
                  await bff(`sections/${sectionId}/assignments/${row.id}`, { method: "PATCH", body: rest });
                  if (String(p.rubric ?? "") !== rubricText(row.rubric)) await bff(`sections/${sectionId}/assignments/${row.id}/rubric`, { method: "PUT", body: { items: rubric } });
                }, c("saved"));
                if (ok) setForm(null);
              }}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function SubmissionsView({ sectionId, assignment, onBack }: { sectionId: string; assignment: Asg; onBack: () => void }) {
  const t = useTranslations("pages.assignments");
  const c = useTranslations("crud");
  const base = `sections/${sectionId}/assignments/${assignment.id}`;
  const [data, setData] = React.useState<{ rows: SubRow[] } | null>(null);
  const [detail, setDetail] = React.useState<SubDetail | null>(null);
  const load = React.useCallback(() => { void bff<{ rows: SubRow[] }>(`${base}/submissions`).then(setData); }, [base]);
  React.useEffect(load, [load]);
  const { run, message } = useAct(() => { load(); });
  const { ask, dialog } = usePromptDialog();
  const [points, setPoints] = React.useState<Record<string, string>>({});
  const [feedback, setFeedback] = React.useState("");
  async function openSub(id: string) {
    const d = await bff<SubDetail>(`${base}/submissions/${id}`);
    setDetail(d);
    setPoints(Object.fromEntries(d.scores.map((s) => [s.rubricItemId, String(s.points)])));
    setFeedback(d.feedback ?? "");
  }
  const scores = () => assignment.rubric.filter((r) => points[r.id] !== undefined && points[r.id] !== "").map((r) => ({ rubricItemId: r.id, points: Number(points[r.id]) }));
  async function extend(r: SubRow) {
    const v = await ask(t("extDays"), [{ name: "days", label: t("extDays"), type: "number" }, { name: "reason", label: t("extReason"), type: "textarea" }]);
    if (!v) return;
    const days = Number(v.days);
    const reason = v.reason;
    if (!days || reason.trim().length < 3) return;
    await run(() => bff(`${base}/extensions/${r.studentPersonId}`, { method: "PUT", body: { days, reason } }), c("done"));
  }
  return (
    <div>
      {message}
      {dialog}
      <div className="mb-2 flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={onBack}>{t("back")}</Button>
        <span className="font-medium">{assignment.title}</span>
        <PermButton perm={PERMS.eduSubmissionGrade} size="sm" onClick={() => void run(() => bff(`${base}/publish-grades`, { method: "POST" }), c("done"))}>{t("publishAll")}</PermButton>
      </div>
      <table className="mb-3 w-full text-left">
        <thead className="text-muted"><tr><th className="py-1">{t("student")}</th><th>{t("status")}</th><th>{t("submittedAt")}</th><th>{t("late")}</th><th>{t("score")}</th><th /></tr></thead>
        <tbody>
          {data?.rows.map((r) => (
            <tr key={r.studentPersonId} className="border-t border-border">
              <td className="py-1">{r.fullName} {r.studentNo ? `(${r.studentNo})` : ""}</td>
              <td>{t(`sub_${r.status}`)}</td>
              <td>{r.submittedAt ? new Date(r.submittedAt).toLocaleString() : ""}</td>
              <td>{r.submissionId && r.isLate ? t("lateInfo", { h: r.hoursLate, p: r.latePenaltyPct ?? 0 }) : ""}{r.extension ? ` ${t("extended", { d: r.extension.days })}` : ""}</td>
              <td>{r.finalScore ?? ""}</td>
              <td className="flex gap-1 py-1">
                {r.submissionId ? <PermRowAction perm={PERMS.eduSubmissionList} onClick={() => void openSub(r.submissionId!)} icon={ExternalLink}>{t("open")}</PermRowAction> : null}
                <PermRowAction perm={PERMS.eduExtensionEdit} onClick={() => void extend(r)} icon={CalendarPlus}>{t("extend")}</PermRowAction>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {detail ? (
        <div className="rounded-md border border-border p-3">
          <h4 className="mb-2 font-medium">{detail.fullName} — {t(`sub_${detail.status}`)}</h4>
          {detail.versions.map((v) => (
            <div key={v.version} className="mb-2">
              <div className="text-muted">{t("version", { n: v.version })} · {new Date(v.submittedAt).toLocaleString()} {v.isLate ? `· ${t("late")}` : ""}</div>
              {v.textAnswer ? <p className="whitespace-pre-wrap">{v.textAnswer}</p> : null}
              <ul className="list-disc pl-5">{v.files.map((f) => <li key={f.id}><a className="underline" href={f.downloadUrl} rel="noopener noreferrer">{f.fileName}</a> ({Math.ceil(f.size / 1024)} KB)</li>)}</ul>
            </div>
          ))}
          <Can perm={PERMS.eduSubmissionGrade}>
            {detail.status !== "published" ? (
              <div className="mt-2 flex flex-col gap-2">
                {assignment.rubric.map((r) => (
                  <label key={r.id} className="flex items-center gap-2">{r.title} (/{r.maxPoints})
                    <input type="number" min={0} max={r.maxPoints} step="0.5" className={`${input} w-24`} value={points[r.id] ?? ""} onChange={(e) => setPoints({ ...points, [r.id]: e.target.value })} /></label>
                ))}
                <label className="flex flex-col gap-1">{t("feedback")}<textarea className={input} value={feedback} onChange={(e) => setFeedback(e.target.value)} /></label>
                <div className="flex gap-2">
                  <PermButton perm={PERMS.eduSubmissionGrade} size="sm" onClick={() => void run(() => bff(`${base}/submissions/${detail.id}/grade`, { method: "PUT", body: { scores: scores(), feedback: feedback || null } }), c("saved")).then(() => openSub(detail.id))}>{t("saveScores")}</PermButton>
                  <PermRowAction perm={PERMS.eduSubmissionGrade} onClick={() => void run(() => bff(`${base}/submissions/${detail.id}/publish`, { method: "POST" }), c("done")).then(() => openSub(detail.id))} icon={Send}>{t("publishScore")}</PermRowAction>
                </div>
              </div>
            ) : <p className="mt-2">{t("finalScore")}: {detail.finalScore} ({t("raw")} {detail.rawScore}, {t("penalty")} {detail.latePenaltyPct ?? 0}%)</p>}
          </Can>
        </div>
      ) : null}
    </div>
  );
}

/** 课程详情里的"作业"页签：这个班已发布的作业（截止时间、状态、得分），提交在"我的作业"里。 */
export function StudentAssignments({ sectionId }: { sectionId: string }) {
  const t = useTranslations("pages.assignments");
  const tbl = useTable();
  const [rows, setRows] = React.useState<MyRow[] | null>(null);
  const [open, setOpen] = React.useState<MyRow | null>(null);
  const load = React.useCallback(() => { void bff<MyRow[]>("assignments").then((all) => setRows(all.filter((a) => a.section.id === sectionId))).catch(() => setRows([])); }, [sectionId]);
  React.useEffect(load, [load]);
  const cols: Column<MyRow>[] = [
    { key: "title", header: t("colTitle"), cell: (a) => <button type="button" className="font-medium text-primary hover:underline" onClick={() => setOpen(a)}>{a.title}</button> },
    { key: "deadline", header: t("colDeadline"), cell: (a) => `${new Date(a.deadline).toLocaleString()}${a.extensionDays ? ` · ${t("extended", { d: a.extensionDays })}` : ""}` },
    { key: "status", header: t("colStatus"), cell: (a) => t(`sub_${a.status}`) },
    { key: "score", header: t("colScore"), cell: (a) => (a.finalScore !== null ? `${a.finalScore}/${a.maxScore}` : "—") },
    { key: "actions", header: "", cell: (a) => <RowAction icon={Eye} onClick={() => setOpen(a)}>{t("open")}</RowAction> },
  ];
  return (
    <div>
      {open ? <Modal wide title={open.title} onClose={() => setOpen(null)}><StudentAssignmentDetail id={open.id} onChanged={load} /></Modal> : null}
      <DataTable columns={cols} rows={rows ?? []} rowKey={(a) => a.id} loading={rows === null} emptyText={t("studentEmpty")} loadingText={tbl.loading} selectable={false} labels={tbl.labels} />
      {rows && rows.length ? <p className="mt-2 text-muted">{t("submitHint")}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------- 学生门户：我的作业
interface MyRow { id: string; title: string; section: { id: string; name: string; course: string }; deadline: string; extensionDays: number; status: string; isLate: boolean; finalScore: number | null; maxScore: number }
interface MyDetail {
  id: string; title: string; description: string; section: { name: string }; deadline: string; allowLate: boolean; maxScore: number; canSubmit: boolean; limits: { maxFiles: number };
  rubric: Array<{ id: string; title: string; maxPoints: number }>;
  submission: null | { status: string; currentVersion: number; isLate: boolean; latePenaltyPct: number | null; versions: Array<{ version: number; textAnswer: string | null; submittedAt: string; isLate: boolean; files: Array<{ id: string; fileName: string; downloadUrl: string }> }>; result: null | { rawScore: number; latePenaltyPct: number; finalScore: number; feedback: string | null; scores: Array<{ rubricItemId: string; points: number }> } };
}

/** 学生看一份作业的详情、提交记录和成绩，也能在这里提交；"我的作业"页和课程详情的作业页签共用。 */
export function StudentAssignmentDetail({ id, onBack, onChanged }: { id: string; onBack?: () => void; onChanged: () => void }) {
  const t = useTranslations("pages.assignments");
  const c = useTranslations("crud");
  const [d, setD] = React.useState<MyDetail | null>(null);
  const [text, setText] = React.useState("");
  const [files, setFiles] = React.useState<File[]>([]);
  const [msg, setMsg] = React.useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const load = React.useCallback((id: string) => { void bff<MyDetail>(`assignments/${id}`).then((x) => { setD(x); setText(x.submission?.versions.at(-1)?.textAnswer ?? ""); }); }, []);
  React.useEffect(() => { load(id); }, [id, load]);

  async function submit() {
    if (!d) return;
    setBusy(true);
    try {
      const fileIds: string[] = [];
      for (const f of files) {
        const up = await bff<{ fileId: string; uploadUrl: string; headers: Record<string, string> }>(`assignments/${d.id}/uploads`, { method: "POST", body: { fileName: f.name, contentType: f.type || "application/octet-stream", size: f.size } });
        const put = await fetch(up.uploadUrl, { method: "PUT", headers: up.headers, body: f });
        if (!put.ok) throw new Error(t("uploadFailed", { name: f.name }));
        fileIds.push(up.fileId);
      }
      await bff(`assignments/${d.id}/submissions`, { method: "POST", body: { text: text || undefined, fileIds } });
      setMsg({ text: c("done"), error: false });
      setFiles([]);
      load(d.id);
      onChanged();
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }

  if (!d) return <p className="text-sm text-muted">…</p>;
  {
    const s = d.submission;
    return (
      <section className="text-sm">
        {onBack ? <RowAction icon={ArrowLeft} className="mb-2" onClick={onBack}>{t("back")}</RowAction> : null}
        {onBack ? <H2>{d.title}</H2> : null}
        <p className="mb-1 text-muted">{d.section.name} · {t("deadline", { when: new Date(d.deadline).toLocaleString() })} · {t("maxScore", { n: d.maxScore })}</p>
        {d.description ? <p className="mb-2 whitespace-pre-wrap">{d.description}</p> : null}
        <h3 className="mb-1 font-medium">{t("rubric")}</h3>
        <ul className="mb-3 list-disc pl-5">{d.rubric.map((r) => <li key={r.id}>{r.title} ({r.maxPoints})</li>)}</ul>
        {s ? <p className="mb-2">{t("yourStatus")}: {t(`sub_${s.status}`)} · {t("version", { n: s.currentVersion })}{s.isLate ? ` · ${t("lateInfo", { h: "", p: s.latePenaltyPct ?? 0 })}` : ""}</p> : <p className="mb-2 text-muted">{t("sub_missing")}</p>}
        {s?.result ? (
          <div className="mb-3 rounded-md border border-border p-2">
            <p className="font-medium">{t("finalScore")}: {s.result.finalScore} / {d.maxScore} ({t("raw")} {s.result.rawScore}, {t("penalty")} {s.result.latePenaltyPct}%)</p>
            <ul className="list-disc pl-5">{d.rubric.map((r) => <li key={r.id}>{r.title}: {s.result!.scores.find((x) => x.rubricItemId === r.id)?.points ?? "-"}</li>)}</ul>
            {s.result.feedback ? <p className="mt-1 whitespace-pre-wrap">{s.result.feedback}</p> : null}
          </div>
        ) : null}
        {s?.versions.map((v) => (
          <div key={v.version} className="mb-1 text-muted">{t("version", { n: v.version })} · {new Date(v.submittedAt).toLocaleString()} {v.files.map((f) => <a key={f.id} className="ml-2 underline" href={f.downloadUrl} rel="noopener noreferrer">{f.fileName}</a>)}</div>
        ))}
        {msg ? <p role={msg.error ? "alert" : "status"} className={`my-2 ${msg.error ? "text-red-600" : "text-muted"}`}>{msg.text}</p> : null}
        {d.canSubmit ? (
          <div className="mt-3 flex flex-col gap-2">
            <label className="flex flex-col gap-1">{t("yourAnswer")}<textarea className={input} rows={5} value={text} onChange={(e) => setText(e.target.value)} /></label>
            <label className="flex flex-col gap-1">{t("files", { n: d.limits.maxFiles })}<input type="file" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} /></label>
            <p className="text-xs text-muted">{t("resubmitNote")}</p>
            <PermButton perm={PERMS.portalAssignmentSubmit} size="sm" disabled={busy || (!text.trim() && files.length === 0)} onClick={() => void submit()}>{s ? t("resubmit") : t("submit")}</PermButton>
          </div>
        ) : <p className="mt-2 text-muted">{t("cannotSubmit")}</p>}
      </section>
    );
  }
}

export function PortalAssignmentsPage() {
  const t = useTranslations("pages.assignments");
  const tbl = useTable();
  const list = useList<MyRow>("assignments");
  const [openId, setOpenId] = React.useState<string | null>(null);
  if (openId) return <StudentAssignmentDetail id={openId} onBack={() => setOpenId(null)} onChanged={list.reload} />;
  return (
    <section className="text-sm">
      <H2>{t("myTitle")}</H2>
      <DataTable
        columns={[
          { key: "title", header: t("colTitle"), cell: (a) => <button className="font-medium text-primary hover:underline" onClick={() => setOpenId(a.id)}>{a.title}</button> },
          { key: "course", header: t("colCourse"), cell: (a) => a.section.course },
          { key: "deadline", header: t("colDeadline"), cell: (a) => `${new Date(a.deadline).toLocaleString()}${a.extensionDays ? ` · ${t("extended", { d: a.extensionDays })}` : ""}` },
          { key: "status", header: t("colStatus"), cell: (a) => t(`sub_${a.status}`) },
          { key: "score", header: t("colScore"), cell: (a) => (a.finalScore !== null ? `${a.finalScore}/${a.maxScore}` : "—") },
          { key: "actions", header: "", cell: (a) => <RowAction icon={Eye} onClick={() => setOpenId(a.id)}>{t("open")}</RowAction> },
        ] as Column<MyRow>[]}
        rows={list.rows}
        rowKey={(a) => a.id}
        loading={list.loading}
        emptyText={tbl.empty}
        loadingText={tbl.loading}
        selectable={false}
        labels={tbl.labels}
      />
    </section>
  );
}
