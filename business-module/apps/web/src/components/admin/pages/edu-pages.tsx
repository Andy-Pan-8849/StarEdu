"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { TabBody, Tabs } from "../tabs";
import { Eye, Pencil, Plus, RefreshCw, Trash2, UserPlus, UsersRound } from "lucide-react";
import { IconButton, PermRowAction, RowAction } from "../icon-button";
import { PERMS } from "@staredu/shared";
import { Button } from "@/components/ui/button";
import { bff } from "@/lib/bff";
import { Modal } from "../modal";
import { DataTable, type Column } from "../data-table";
import { Can, PermButton, usePermissions } from "../permissions";
import { AssignmentsPanel } from "./assignment-pages";
import { MaterialsPanel } from "./material-pages";
import { DiscussionPanel } from "./discussion-pages";
import { GradesPanel } from "./grade-pages";
import { FormPanel, useAct, type Field } from "./crud";
import { useList } from "./use-api";
import { useDict } from "../use-dict";
import { CourseDetailDialog, CourseLink } from "./course-pages";
import { CourseDialog } from "./course-dialogs";
import { MajorDialog, type MajorRow } from "./major-dialogs";
import { StudentPicker } from "./student-picker";
import { SEARCH_SELECT_LIMIT, SearchSelect, type Picked } from "./search-select";

const H2 = ({ children }: { children: React.ReactNode }) => <h2 className="mb-3 text-lg font-semibold">{children}</h2>;
const Err = ({ error }: { error: string | null }) => (error ? <p role="alert" className="mb-2 text-sm text-red-600">{error}</p> : null);
function useTable() {
  const t = useTranslations("table");
  return { empty: t("empty"), loading: t("loading"), labels: { actions: t("actions"), more: t("more"), selectAll: t("selectAll"), selectRow: t("selectRow"), clearSelection: t("clearSelection"), selected: (n: number) => t("selected", { n }), previous: t("previous"), next: t("next"), page: (p: number, n: number) => t("page", { page: p, pages: n }) } };
}

// ---------------------------------------------------------------- 学期
interface TermRow { id: string; code: string; name: string; startDate: string; endDate: string; enrollOpenDate: string | null; enrollCloseDate: string | null; dropDeadline: string | null; status: string }
const TERM_NEXT: Record<string, string[]> = { planned: ["enrolling"], enrolling: ["planned", "in_progress"], in_progress: ["ended"], ended: [] };

export function TermsPage() {
  const t = useTranslations("pages.edu");
  const c = useTranslations("crud");
  const tt = useTable();
  const { rows, loading, error, reload } = useList<TermRow>("terms");
  const { run, message } = useAct(reload);
  const [form, setForm] = React.useState<{ row?: TermRow } | null>(null);
  const fields: Field[] = [
    { name: "code", label: t("code"), required: true, readOnly: !!form?.row },
    { name: "name", label: t("name"), required: true },
    { name: "startDate", label: t("startDate"), required: true },
    { name: "endDate", label: t("endDate"), required: true },
    { name: "enrollOpenDate", label: t("enrollOpen") },
    { name: "enrollCloseDate", label: t("enrollClose") },
    { name: "dropDeadline", label: t("dropDeadline") },
  ];
  const columns: Column<TermRow>[] = [
    { key: "code", header: t("code"), cell: (r) => r.code },
    { key: "name", header: t("name"), cell: (r) => r.name },
    { key: "dates", header: t("dates"), cell: (r) => `${r.startDate} → ${r.endDate}` },
    { key: "window", header: t("enrollWindow"), cell: (r) => (r.enrollOpenDate ? `${r.enrollOpenDate} → ${r.enrollCloseDate ?? ""}` : "") },
    { key: "drop", header: t("dropDeadline"), cell: (r) => r.dropDeadline ?? "" },
    { key: "status", header: c("status"), cell: (r) => t(`term_${r.status}`) },
    {
      key: "actions",
      header: "",
      cell: (r) => (
        <div className="flex flex-wrap gap-1">
          {r.status !== "ended" ? <PermRowAction perm={PERMS.eduTermEdit} onClick={() => setForm({ row: r })} icon={Pencil}>{c("edit")}</PermRowAction> : null}
          {TERM_NEXT[r.status].map((next) => (
            <PermRowAction key={next} perm={PERMS.eduTermEdit} onClick={() => (next !== "ended" || window.confirm(t("confirmEnd", { name: r.name }))) && void run(() => bff(`terms/${r.id}/status`, { method: "POST", body: { status: next } }), c("done"))} icon={RefreshCw}>{t(`to_${next}`)}</PermRowAction>
          ))}
        </div>
      ),
    },
  ];
  return (
    <section>
      <H2>{t("termsTitle")}</H2>
      <Err error={error} />
      {message}
      <Can perm={PERMS.eduTermAdd}>{!form ? <IconButton icon={Plus} label={c("add")} onClick={() => setForm({})} className="mb-3"/> : null}</Can>
      {form ? (
        <FormPanel key={form.row?.id ?? "new"} title={form.row ? c("edit") : c("add")} fields={fields}
          initial={form.row ? { code: form.row.code, name: form.row.name, startDate: form.row.startDate, endDate: form.row.endDate, enrollOpenDate: form.row.enrollOpenDate ?? "", enrollCloseDate: form.row.enrollCloseDate ?? "", dropDeadline: form.row.dropDeadline ?? "" } : {}}
          submitLabel={c("save")} cancelLabel={c("cancel")} onCancel={() => setForm(null)}
          onSubmit={async (p) => { const { code, ...rest } = p; if (await run(() => (form.row ? bff(`terms/${form.row.id}`, { method: "PATCH", body: rest }) : bff("terms", { method: "POST", body: { code, ...rest } })), c("saved"))) setForm(null); }} />
      ) : null}
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
    </section>
  );
}

// ---------------------------------------------------------------- 课程
interface CourseRow { id: string; code: string; name: string; credits: number; status: boolean }

export function CoursesPage() {
  const t = useTranslations("pages.edu");
  const c = useTranslations("crud");
  const tt = useTable();
  const { rows, loading, error, reload } = useList<CourseRow>("courses");
  const { run, message } = useAct(reload);
  const [form, setForm] = React.useState<boolean>(false); // 新增（编辑在 CourseDialog 里）
  const [open, setOpen] = React.useState<{ id: string; mode: "view" | "edit" } | null>(null);
  const fields: Field[] = [
    { name: "code", label: t("code"), required: true },
    { name: "name", label: t("name"), required: true },
    { name: "credits", label: t("credits"), type: "number", required: true },
    { name: "syllabus", label: t("syllabusField"), type: "textarea" },
  ];
  const columns: Column<CourseRow>[] = [
    { key: "code", header: t("code"), cell: (r) => r.code },
    { key: "name", header: t("name"), cell: (r) => r.name },
    { key: "credits", header: t("credits"), cell: (r) => r.credits },
    { key: "status", header: c("status"), cell: (r) => (r.status ? c("enabled") : c("disabled")) },
    {
      key: "actions",
      header: "",
      cell: (r) => (
        <div className="flex gap-1">
          <RowAction onClick={() => setOpen({ id: r.id, mode: "view" })} icon={Eye}>{t("details")}</RowAction>
          <PermRowAction perm={PERMS.eduCourseEdit} onClick={() => setOpen({ id: r.id, mode: "edit" })} icon={Pencil}>{c("edit")}</PermRowAction>
        </div>
      ),
    },
  ];
  return (
    <section>
      <H2>{t("coursesTitle")}</H2>
      <Err error={error} />
      {message}
      <Can perm={PERMS.eduCourseAdd}>{!form ? <IconButton icon={Plus} label={c("add")} onClick={() => setForm(true)} className="mb-3"/> : null}</Can>
      {form ? (
        <FormPanel key="new" title={c("add")} fields={fields} submitLabel={c("save")} cancelLabel={c("cancel")} onCancel={() => setForm(false)}
          onSubmit={async (p) => { if (await run(() => bff("courses", { method: "POST", body: p }), c("saved"))) setForm(false); }} />
      ) : null}
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
      {open ? <CourseDialog id={open.id} mode={open.mode} onClose={() => setOpen(null)} onSaved={reload} /> : null}
    </section>
  );
}

// ---------------------------------------------------------------- 专业

export function MajorsPage() {
  const t = useTranslations("pages.edu");
  const c = useTranslations("crud");
  const tt = useTable();
  const { rows, loading, error, reload } = useList<MajorRow>("majors");
  const degrees = useDict("degree_type");
  const { run, message } = useAct(reload);
  const [form, setForm] = React.useState(false); // 新增（详情、编辑在 MajorDialog 里）
  const [open, setOpen] = React.useState<{ row: MajorRow; mode: "view" | "edit" } | null>(null);
  const columns: Column<MajorRow>[] = [
    { key: "code", header: t("code"), cell: (r) => r.code },
    { key: "name", header: t("name"), cell: (r) => r.name },
    { key: "degree", header: t("degreeType"), cell: (r) => degrees.label(r.degreeType) },
    { key: "credits", header: t("totalCredits"), cell: (r) => r.totalCredits },
    {
      key: "actions",
      header: "",
      cell: (r) => (
        <>
          <RowAction onClick={() => setOpen({ row: r, mode: "view" })} icon={Eye}>{t("details")}</RowAction>
          <PermRowAction perm={PERMS.eduMajorEdit} onClick={() => setOpen({ row: r, mode: "edit" })} icon={Pencil}>{c("edit")}</PermRowAction>
        </>
      ),
    },
  ];
  return (
    <section>
      <H2>{t("majorsTitle")}</H2>
      <Err error={error} />
      {message}
      <Can perm={PERMS.eduMajorAdd}>{!form ? <IconButton icon={Plus} label={c("add")} onClick={() => setForm(true)} className="mb-3"/> : null}</Can>
      {form ? (
        <FormPanel key="new" title={c("add")}
          fields={[{ name: "code", label: t("code"), required: true }, { name: "name", label: t("name"), required: true }, { name: "degreeType", label: t("degreeType"), type: "select" as const, options: degrees.options }, { name: "totalCredits", label: t("totalCredits"), type: "number" as const }]}
          submitLabel={c("save")} cancelLabel={c("cancel")} onCancel={() => setForm(false)}
          onSubmit={async (p) => { if (await run(() => bff("majors", { method: "POST", body: p }), c("saved"))) setForm(false); }} />
      ) : null}
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
      {open ? <MajorDialog row={open.row} mode={open.mode} onClose={() => setOpen(null)} onSaved={reload} /> : null}
    </section>
  );
}

// ---------------------------------------------------------------- 班级
interface SectionRow { id: string; name: string; status: string; capacity: number; seated: number; mode: string; course: { code: string; name: string }; term: { id: string; name: string }; campus: { name: string }; instructors: Array<{ personId: string; fullName: string | null; role: string }> }
interface RosterRow { id: string; studentPersonId: string; fullName: string | null; studentNo: string | null; status: string; method: string }
interface StaffOpt { id: string; fullName: string }
const SEC_NEXT: Record<string, string[]> = { draft: ["open", "cancelled"], open: ["draft", "in_progress", "cancelled"], in_progress: ["ended", "cancelled"], ended: [], cancelled: [] };

export function SectionsPage() {
  const t = useTranslations("pages.edu");
  const c = useTranslations("crud");
  const tt = useTable();
  const sections = useList<SectionRow>("sections");
  const terms = useList<TermRow>("terms");
  const courses = useList<CourseRow>("courses");
  const campuses = useList<{ id: string; name: string; status: string }>("edu-campuses");
  const { run, message } = useAct(sections.reload);
  const [form, setForm] = React.useState(false);
  const [batchOpen, setBatchOpen] = React.useState(false);
  const [open, setOpen] = React.useState<string | null>(null);
  const columns: Column<SectionRow>[] = [
    { key: "name", header: t("name"), cell: (r) => r.name },
    { key: "campus", header: t("campus"), cell: (r) => r.campus.name },
    { key: "seats", header: t("seats"), cell: (r) => `${r.seated} / ${r.capacity}` },
    { key: "teachers", header: t("instructors"), cell: (r) => r.instructors.map((i) => i.fullName).filter(Boolean).join(", ") },
    { key: "status", header: c("status"), cell: (r) => t(`sec_${r.status}`) },
    {
      key: "actions",
      header: "",
      cell: (r) => (
        <div className="flex flex-wrap gap-1">
          <RowAction onClick={() => setOpen(r.id)} icon={Eye}>{t("details")}</RowAction>
          {SEC_NEXT[r.status].map((next) => (
            <PermRowAction key={next} perm={PERMS.eduSectionStatus} onClick={() => (next !== "cancelled" || window.confirm(t("confirmCancel", { name: r.name }))) && void run(() => bff(`sections/${r.id}/status`, { method: "POST", body: { status: next } }), c("done"))} icon={RefreshCw} tip={t(`tip_sec_${next}`)}>{t(`to_sec_${next}`)}</PermRowAction>
          ))}
        </div>
      ),
    },
  ];
  return (
    <section>
      <H2>{t("sectionsTitle")}</H2>
      <p className="mb-3 text-sm text-muted">{t("sectionsNote")}</p>
      <Err error={sections.error} />
      {message}
      <Can perm={PERMS.eduSectionAdd}>{!form ? <IconButton icon={Plus} label={c("add")} onClick={() => setForm(true)} className="mb-3"/> : null}</Can>
      <Can perm={PERMS.eduEnrollmentAdd}>{!batchOpen ? <RowAction className="mb-3 ml-2" onClick={() => setBatchOpen(true)} icon={UsersRound}>{t("batchEnroll")}</RowAction> : null}</Can>
      {batchOpen ? <BatchEnrollPanel onClose={() => { setBatchOpen(false); sections.reload(); }} /> : null}
      {form ? (
        <FormPanel title={c("add")} submitLabel={c("save")} cancelLabel={c("cancel")} onCancel={() => setForm(false)}
          fields={[
            { name: "courseId", label: t("course"), type: "select", required: true, options: courses.rows.filter((x) => x.status).map((x) => ({ value: x.id, label: `${x.code} · ${x.name}` })) },
            { name: "termId", label: t("term"), type: "select", required: true, options: terms.rows.filter((x) => x.status !== "ended").map((x) => ({ value: x.id, label: x.name })) },
            { name: "campusId", label: t("campus"), type: "select", required: true, options: campuses.rows.filter((x) => x.status === "normal").map((x) => ({ value: x.id, label: x.name })) },
            { name: "number", label: t("number"), required: true },
            { name: "capacity", label: t("capacity"), type: "number", required: true },
          ]}
          onSubmit={async (p) => { if (await run(() => bff("sections", { method: "POST", body: p }), c("saved"))) setForm(false); }} />
      ) : null}
      <DataTable columns={columns} rows={sections.rows} rowKey={(r) => r.id} loading={sections.loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
      {open ? <SectionPanel id={open} onClose={() => { setOpen(null); sections.reload(); }} /> : null}
    </section>
  );
}

interface BatchRow { studentId: string; fullName: string | null; studentNo: string | null; sectionName: string | null; ok: boolean; code?: string; violations?: string[]; message?: string }
interface BatchResult { dryRun: boolean; summary: { selected: number; ok: number; needConfirmation: number; blocked: number }; rows: BatchRow[] }

/** 批量安排选课：按专业、入学年份、校区选出学生，先预览，再执行（规则和教务代选相同，超员等要确认并填原因）。 */
export function BatchEnrollPanel({ onClose }: { onClose: () => void }) {
  const t = useTranslations("pages.edu");
  const c = useTranslations("crud");
  const campuses = useList<{ id: string; name: string; status: string }>("edu-campuses");
  const [term, setTerm] = React.useState<Picked | null>(null);
  const [course, setCourse] = React.useState<Picked | null>(null);
  const [major, setMajor] = React.useState<Picked | null>(null);
  const [f, setF] = React.useState({ entryYear: "", campusId: "", reason: "" });
  const [confirm, setConfirm] = React.useState<string[]>([]);
  const [result, setResult] = React.useState<BatchResult | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const body = (dryRun: boolean) => ({ termId: term?.id, courseId: course?.id, majorId: major?.id, ...(f.entryYear ? { entryYear: Number(f.entryYear) } : {}), ...(f.campusId ? { campusId: f.campusId } : {}), ...(confirm.length ? { confirm } : {}), ...(f.reason ? { reason: f.reason } : {}), dryRun });
  async function go(dryRun: boolean) {
    try { setMsg(null); setResult(await bff<BatchResult>("enrollment-batches", { method: "POST", body: body(dryRun) })); } catch (e) { setMsg((e as Error).message); }
  }
  const ready = Boolean(term && course && major);
  const sel = (label: string, key: keyof typeof f, opts: Array<{ value: string; label: string }>, optional = false) => (
    <label className="flex flex-col gap-1 text-sm">{label}
      <select className="rounded-md border border-border bg-transparent px-2 py-1" value={f[key]} onChange={(e) => { setF({ ...f, [key]: e.target.value }); setResult(null); }}>
        <option value="">{optional ? t("any") : "—"}</option>
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
  return (
    <Modal wide title={t("batchEnroll")} onClose={onClose}>
    <div className="text-sm">
      <p className="mb-2 text-xs text-muted">{t("batchHelp")}</p>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <SearchSelect label={t("term")} path="terms?open=true" toLabel={(x: TermRow) => x.name} value={term} onChange={(v) => { setTerm(v); setResult(null); }} placeholder={t("typeToSearch")} hint={t("searchHint", { n: SEARCH_SELECT_LIMIT })} noMatches={t("noResults")} />
        <SearchSelect label={t("course")} path="courses?status=enabled" toLabel={(x: CourseRow) => `${x.code} · ${x.name}`} value={course} onChange={(v) => { setCourse(v); setResult(null); }} placeholder={t("typeToSearch")} hint={t("searchHint", { n: SEARCH_SELECT_LIMIT })} noMatches={t("noResults")} />
        <SearchSelect label={t("major")} path="majors?status=enabled" toLabel={(x: MajorRow) => `${x.code} · ${x.name}`} value={major} onChange={(v) => { setMajor(v); setResult(null); }} placeholder={t("typeToSearch")} hint={t("searchHint", { n: SEARCH_SELECT_LIMIT })} noMatches={t("noResults")} />
        <label className="flex flex-col gap-1">{t("entryYear")}<input type="number" className="w-24 rounded-md border border-border bg-transparent px-2 py-1" value={f.entryYear} onChange={(e) => { setF({ ...f, entryYear: e.target.value }); setResult(null); }} /></label>
        {sel(t("campus"), "campusId", campuses.rows.filter((x) => x.status === "normal").map((x) => ({ value: x.id, label: x.name })), true)}
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span>{t("confirmRules")}:</span>
        {["capacity", "prerequisite", "conflict", "window", "retake"].map((k) => (
          <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={confirm.includes(k)} onChange={(e) => setConfirm((s) => (e.target.checked ? [...s, k] : s.filter((x) => x !== k)))} />{t(`viol_${k}`)}</label>
        ))}
        <input aria-label={t("reason")} placeholder={t("reason")} className="w-64 rounded-md border border-border bg-transparent px-2 py-1" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
      </div>
      <div className="mb-3 flex items-center gap-2">
        <RowAction disabled={!ready} onClick={() => void go(true)} icon={Eye}>{t("preview")}</RowAction>
        <PermButton perm={PERMS.eduEnrollmentAdd} size="sm" disabled={!ready || !result?.dryRun || result.summary.ok + result.summary.needConfirmation === 0} onClick={() => window.confirm(t("batchConfirm", { n: result?.summary.ok ?? 0 })) && void go(false)}>{t("batchRun")}</PermButton>
        <Button size="sm" variant="outline" onClick={onClose}>{c("close")}</Button>
        {msg ? <span role="alert" className="text-red-600">{msg}</span> : null}
      </div>
      {result ? (
        <div>
          <p className="mb-2" role="status">{result.dryRun ? t("batchPreviewed") : t("batchDone")}: {t("batchSummary", { ...result.summary })}</p>
          <table className="text-left"><tbody>
            {result.rows.map((r) => (
              <tr key={r.studentId}>
                <td className="pr-3">{r.fullName} {r.studentNo ? `(${r.studentNo})` : ""}</td>
                <td className="pr-3">{r.sectionName ?? ""}</td>
                <td className={r.ok ? "" : "text-amber-600"}>{r.ok ? (result.dryRun ? t("batchWill") : t("batchEnrolled")) : `${r.code ?? ""}${r.violations?.length ? ` (${r.violations.map((v) => t(`viol_${v}`)).join(", ")})` : ""}`}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      ) : null}
    </div>
    </Modal>
  );
}

function SectionPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useTranslations("pages.edu");
  const c = useTranslations("crud");
  const tt = useTable();
  const [tab, setTab] = React.useState<"roster" | "instructors" | "materials" | "assignments" | "grades" | "discussion">("roster");
  const perms = usePermissions();
  const [s, setS] = React.useState<SectionRow | null>(null);
  const [history, setHistory] = React.useState(false); // 是否列出作废、退课的记录
  const roster = useList<RosterRow>(`sections/${id}/roster${history ? "?history=true" : ""}`);
  const staff = useList<StaffOpt>("staff?size=100");
  const reloadAll = React.useCallback(() => { void bff<SectionRow>(`sections/${id}`).then(setS); roster.reload(); }, [id, roster]);
  React.useEffect(() => { void bff<SectionRow>(`sections/${id}`).then(setS); }, [id]);
  const { run, message } = useAct(reloadAll);
  const [adding, setAdding] = React.useState(false);
  const [teacher, setTeacher] = React.useState("");
  if (!s) return <Modal title={t("details")} onClose={onClose}><p className="text-sm text-muted">…</p></Modal>;
  const rosterCols: Column<RosterRow>[] = [
    { key: "no", header: t("studentNo"), cell: (r) => r.studentNo ?? "" },
    { key: "name", header: t("name"), cell: (r) => r.fullName ?? "" },
    { key: "status", header: c("status"), cell: (r) => t(`enr_${r.status}`) },
    { key: "method", header: t("method"), cell: (r) => (r.method === "registrar" ? t("byRegistrar") : t("bySelf")) },
    { key: "a", header: "", cell: (r) => (r.status === "enrolled" ? <PermRowAction perm={PERMS.eduEnrollmentRemove} onClick={() => void run(() => bff(`sections/${id}/enrollments/${r.id}`, { method: "DELETE" }), c("done"))} icon={Trash2} danger>{t("remove")}</PermRowAction> : null) },
  ];
  return (
    <Modal wide title={`${s.name} — ${s.seated}/${s.capacity} · ${t(`sec_${s.status}`)}`} onClose={onClose}>
    <div className="text-sm">
      <Tabs value={tab} onChange={setTab} items={(["roster", "instructors", "materials", "assignments", "grades", "discussion"] as const).filter((k) => (k !== "assignments" || perms.has(PERMS.eduAssignmentList)) && (k !== "grades" || perms.has(PERMS.eduGradeList)) && (k !== "discussion" || perms.has(PERMS.eduDiscussionList))).map((k) => ({ key: k, label: t(`tab_${k}`) }))} />
      <TabBody>
      {message}
      {tab === "roster" ? (
        <div>
          <Can perm={PERMS.eduEnrollmentAdd}><IconButton icon={Plus} label={t("addStudents")} className="mb-3" onClick={() => setAdding(true)} /></Can>
          <label className="mb-2 flex items-center gap-1 text-xs text-muted"><input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} />{t("showHistory")}</label>
          <DataTable columns={rosterCols} rows={roster.rows} rowKey={(r) => r.id} loading={roster.loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
          {adding ? <StudentPicker sectionId={id} sectionStatus={s.status} exclude={roster.rows.filter((r) => r.status === "enrolled").map((r) => r.studentPersonId)} onChanged={reloadAll} onClose={() => setAdding(false)} /> : null}
        </div>
      ) : null}
      {tab === "instructors" ? (
        <div>
          <ul className="mb-2 list-disc pl-5">{s.instructors.map((i) => <li key={i.personId}>{i.fullName} ({t(`role_${i.role}`)})</li>)}</ul>
          <Can perm={PERMS.eduSectionEdit}>
            <select aria-label={t("pickTeacher")} className="mr-2 rounded-md border border-border bg-transparent px-2 py-1" value={teacher} onChange={(e) => setTeacher(e.target.value)}><option value="" />{staff.rows.map((x) => <option key={x.id} value={x.id}>{x.fullName}</option>)}</select>
            <PermButton perm={PERMS.eduSectionEdit} size="sm" disabled={!teacher} onClick={() => void run(() => bff(`sections/${id}/instructors`, { method: "PUT", body: { items: [...s.instructors.map((i) => ({ personId: i.personId, role: i.role })), { personId: teacher, role: s.instructors.length ? "assistant" : "lead" }] } }), c("saved"))}>{t("addInstructor")}</PermButton>
          </Can>
        </div>
      ) : null}
      {tab === "materials" ? <MaterialsPanel sectionId={id} /> : null}
      {tab === "assignments" ? <AssignmentsPanel sectionId={id} /> : null}
      {tab === "grades" ? <GradesPanel sectionId={id} /> : null}
      {tab === "discussion" ? <DiscussionPanel sectionId={id} /> : null}
      </TabBody>
      <div className="mt-4 border-t border-border pt-3"><Button size="sm" variant="outline" onClick={onClose}>{c("close")}</Button></div>
    </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- 学生门户：选课
interface OpenSection { id: string; name: string; course: { code: string; name: string; credits: number }; campus: string; seatsLeft: number; capacity: number; requirement: string | null; prerequisitesMet: boolean; missingPrerequisites: string[]; conflicts: string[]; alreadyTaking: boolean; alreadyPassed: boolean; instructors: Array<{ fullName: string | null }> }
export function PortalEnrollPage() {
  const t = useTranslations("pages.edu");
  const [majorId, setMajorId] = React.useState(""); // "" = 全部课程
  const [data, setData] = React.useState<{ declaredMajor: { name: string } | null; majors: Array<{ id: string; name: string; kind: string }>; sections: OpenSection[] } | null>(null);
  const [detail, setDetail] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ text: string; error: boolean } | null>(null);
  const load = React.useCallback(() => {
    void bff<{ declaredMajor: { name: string } | null; majors: Array<{ id: string; name: string; kind: string }>; sections: OpenSection[] }>(`sections${majorId ? `?majorId=${majorId}` : ""}`).then(setData);
  }, [majorId]);
  React.useEffect(load, [load]);
  async function act(fn: () => Promise<unknown>, ok: string) {
    try { const r = await fn(); const conflicts = (r as { conflicts?: Array<{ name: string }> })?.conflicts ?? []; setMsg({ text: conflicts.length ? `${ok} ${t("clashWarning", { list: conflicts.map((x) => x.name).join(", ") })}` : ok, error: false }); } catch (e) { setMsg({ text: (e as Error).message, error: true }); }
    load();
  }
  const enroll = (sectionId: string) => act(() => bff("enrollments", { method: "POST", body: { sectionId } }), t("enrolledOk"));
  const tbl = useTable();
  if (!data) return <p className="text-sm text-muted">…</p>;
  const openCols: Column<OpenSection>[] = [
    { key: "course", header: t("name"), cell: (s) => (<div><div className="font-medium"><CourseLink onOpen={() => setDetail(s.id)}>{s.course.code} · {s.course.name}</CourseLink> <span className="text-muted">({s.course.credits})</span> {s.requirement ? <span className="ml-1 rounded bg-border/50 px-1">{t(`cat_${s.requirement}`)}</span> : null}</div>
      {!s.prerequisitesMet ? <div className="text-red-600">{t("missingPrereq", { list: s.missingPrerequisites.join(", ") })}</div> : null}
      {s.conflicts.length ? <div className="text-amber-600">{t("clashWarning", { list: s.conflicts.join(", ") })}</div> : null}</div>) },
    { key: "section", header: t("sectionCol"), cell: (s) => `${s.name} · ${s.campus}` },
    { key: "instructors", header: t("instructorsCol"), cell: (s) => s.instructors.map((i) => i.fullName).filter(Boolean).join(", ") },
    { key: "seats", header: t("seatsCol"), cell: (s) => t("seatsLeft", { n: s.seatsLeft }) },
    { key: "actions", header: "", cell: (s) => <PermRowAction perm={PERMS.portalEnrollAdd} disabled={s.alreadyTaking || s.seatsLeft === 0} onClick={() => void enroll(s.id)} icon={UserPlus}>{s.alreadyTaking ? t("taking") : s.seatsLeft === 0 ? t("full") : t("enroll")}</PermRowAction> },
  ];
  return (
    <section className="text-sm">
      <H2>{t("enrollTitle")}</H2>
      <p className="mb-2 text-muted">{t("enrollHint")}</p>
      {!data.declaredMajor ? <p className="mb-2 text-muted">{t("declareFirst")}</p> : null}
      {msg ? <p role={msg.error ? "alert" : "status"} className={`mb-2 ${msg.error ? "text-red-600" : "text-muted"}`}>{msg.text}</p> : null}
      {/* 没有专业就没有可筛的，不给下拉（以前选"只看我的专业"会得到一个空列表） */}
      {data.majors.length > 0 ? (
        <div className="mb-2 flex items-center gap-2">
          <select aria-label={t("filter")} className="rounded-md border border-border bg-transparent px-2 py-1" value={majorId} onChange={(e) => setMajorId(e.target.value)}>
            <option value="">{t("allCourses")}</option>
            {data.majors.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </div>
      ) : null}
      <DataTable columns={openCols} rows={data.sections} rowKey={(s) => s.id} emptyText={tbl.empty} loadingText={tbl.loading} selectable={false} labels={tbl.labels} />
      {detail ? <CourseDetailDialog sectionId={detail} onClose={() => setDetail(null)} onEnroll={(id) => { setDetail(null); void enroll(id); }} /> : null}
    </section>
  );
}
