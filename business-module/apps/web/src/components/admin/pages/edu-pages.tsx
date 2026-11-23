"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { Plus } from "lucide-react";
import { IconButton } from "../icon-button";
import { PERMS } from "@staredu/shared";
import { Button } from "@/components/ui/button";
import { bff } from "@/lib/bff";
import { Modal } from "../modal";
import { DataTable, type Column } from "../data-table";
import { Can, PermButton, usePermissions } from "../permissions";
import { AssignmentsPanel } from "./assignment-pages";
import { DiscussionPanel } from "./discussion-pages";
import { GradesPanel } from "./grade-pages";
import { FormPanel, useAct, type Field } from "./crud";
import { useList } from "./use-api";

const H2 = ({ children }: { children: React.ReactNode }) => <h2 className="mb-3 text-lg font-semibold">{children}</h2>;
const Err = ({ error }: { error: string | null }) => (error ? <p role="alert" className="mb-2 text-sm text-red-600">{error}</p> : null);
function useTable() {
  const t = useTranslations("table");
  return { empty: t("empty"), loading: t("loading"), labels: { actions: t("actions"), selectAll: t("selectAll"), selectRow: t("selectRow"), clearSelection: t("clearSelection"), selected: (n: number) => t("selected", { n }), previous: t("previous"), next: t("next"), page: (p: number, n: number) => t("page", { page: p, pages: n }) } };
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
          {r.status !== "ended" ? <PermButton perm={PERMS.eduTermEdit} size="sm" variant="outline" onClick={() => setForm({ row: r })}>{c("edit")}</PermButton> : null}
          {TERM_NEXT[r.status].map((next) => (
            <PermButton key={next} perm={PERMS.eduTermEdit} size="sm" variant="outline" onClick={() => (next !== "ended" || window.confirm(t("confirmEnd", { name: r.name }))) && void run(() => bff(`terms/${r.id}/status`, { method: "POST", body: { status: next } }), c("done"))}>{t(`to_${next}`)}</PermButton>
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
interface CourseDetail { id: string; code: string; name: string; credits: number; syllabus: string | null; prerequisites: Array<{ id: string; code: string }>; majors: Array<{ code: string; name: string; category: string }>; sections: Array<{ id: string; name: string; status: string }> }

export function CoursesPage() {
  const t = useTranslations("pages.edu");
  const c = useTranslations("crud");
  const tt = useTable();
  const { rows, loading, error, reload } = useList<CourseRow>("courses");
  const { run, message } = useAct(reload);
  const [form, setForm] = React.useState<{ row?: CourseRow } | null>(null);
  const [open, setOpen] = React.useState<string | null>(null);
  const fields: Field[] = [
    { name: "code", label: t("code"), required: true },
    { name: "name", label: t("name"), required: true },
    { name: "credits", label: t("credits"), type: "number", required: true },
    ...(form?.row ? [{ name: "status", label: c("enabled"), type: "checkbox" as const }] : []),
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
          <Button size="sm" variant="outline" onClick={() => setOpen(r.id)}>{t("details")}</Button>
          <PermButton perm={PERMS.eduCourseEdit} size="sm" variant="outline" onClick={() => setForm({ row: r })}>{c("edit")}</PermButton>
        </div>
      ),
    },
  ];
  return (
    <section>
      <H2>{t("coursesTitle")}</H2>
      <Err error={error} />
      {message}
      <Can perm={PERMS.eduCourseAdd}>{!form ? <IconButton icon={Plus} label={c("add")} onClick={() => setForm({})} className="mb-3"/> : null}</Can>
      {form ? (
        <FormPanel key={form.row?.id ?? "new"} title={form.row ? c("edit") : c("add")} fields={fields}
          initial={form.row ? { code: form.row.code, name: form.row.name, credits: String(form.row.credits), status: form.row.status } : {}}
          submitLabel={c("save")} cancelLabel={c("cancel")} onCancel={() => setForm(null)}
          onSubmit={async (p) => { if (await run(() => (form.row ? bff(`courses/${form.row.id}`, { method: "PATCH", body: p }) : bff("courses", { method: "POST", body: p })), c("saved"))) setForm(null); }} />
      ) : null}
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
      {open ? <CourseDetailPanel id={open} all={rows} onClose={() => { setOpen(null); reload(); }} /> : null}
    </section>
  );
}

function CourseDetailPanel({ id, all, onClose }: { id: string; all: CourseRow[]; onClose: () => void }) {
  const t = useTranslations("pages.edu");
  const c = useTranslations("crud");
  const [d, setD] = React.useState<CourseDetail | null>(null);
  const [picked, setPicked] = React.useState<string[]>([]);
  const [msg, setMsg] = React.useState<{ text: string; error: boolean } | null>(null);
  React.useEffect(() => { void bff<CourseDetail>(`courses/${id}`).then((x) => { setD(x); setPicked(x.prerequisites.map((p) => p.id)); }); }, [id]);
  if (!d) return <Modal title={t("details")} onClose={onClose}><p className="text-sm text-muted">…</p></Modal>;
  return (
    <Modal title={`${d.code} · ${d.name}`} onClose={onClose}>
    <div className="text-sm">
      <p className="mb-1 text-muted">{t("prerequisites")}</p>
      <div className="mb-2 flex flex-wrap gap-3">
        {all.filter((x) => x.id !== id).map((x) => (
          <label key={x.id} className="flex items-center gap-1"><input type="checkbox" checked={picked.includes(x.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, x.id] : picked.filter((y) => y !== x.id))} />{x.code}</label>
        ))}
      </div>
      <PermButton perm={PERMS.eduCourseEdit} size="sm" onClick={async () => { try { await bff(`courses/${id}/prerequisites`, { method: "PUT", body: { courseIds: picked } }); setMsg({ text: c("saved"), error: false }); } catch (e) { setMsg({ text: (e as Error).message, error: true }); } }}>{c("save")}</PermButton>
      {msg ? <span role={msg.error ? "alert" : "status"} className={`ml-2 ${msg.error ? "text-red-600" : "text-muted"}`}>{msg.text}</span> : null}
      <p className="mb-1 mt-3 text-muted">{t("appliesTo")}</p>
      <p>{d.majors.map((m) => `${m.name} (${t(`cat_${m.category}`)})`).join(", ") || "—"}</p>
      <p className="mb-1 mt-3 text-muted">{t("history")}</p>
      <p>{d.sections.map((s) => s.name).join(", ") || "—"}</p>
      <div className="mt-4 border-t border-border pt-3"><Button size="sm" variant="outline" onClick={onClose}>{c("close")}</Button></div>
    </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- 专业
interface MajorRow { id: string; code: string; name: string; degreeType: string | null; totalCredits: number; status: boolean }
interface MajorVersionRow { id: string; label: string; effectiveYear: number; entryYearFrom: number | null; entryYearTo: number | null; courseCount: number | null }
interface MajorDetail { id: string; name: string; versionId: string; totalCredits: number; electiveMinCredits: number; versions: MajorVersionRow[]; courses: Array<{ courseId: string; code: string; name: string; credits: number; category: string; suggestedTerm: number | null }> }

export function MajorsPage() {
  const t = useTranslations("pages.edu");
  const c = useTranslations("crud");
  const tt = useTable();
  const { rows, loading, error, reload } = useList<MajorRow>("majors");
  const courses = useList<CourseRow>("courses");
  const { run, message } = useAct(reload);
  const [form, setForm] = React.useState(false);
  const [open, setOpen] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<MajorDetail | null>(null);
  const [items, setItems] = React.useState<Record<string, { category: string; suggestedTerm: string }>>({});
  const [versionId, setVersionId] = React.useState<string | null>(null);
  const [newYear, setNewYear] = React.useState("");
  const [newLabel, setNewLabel] = React.useState("");
  const [credits, setCredits] = React.useState({ total: "", elective: "" });
  const [reloadKey, setReloadKey] = React.useState(0);
  React.useEffect(() => {
    if (!open) return;
    void bff<MajorDetail>(`majors/${open}${versionId ? `?version=${versionId}` : ""}`).then((d) => { setCredits({ total: String(d.totalCredits), elective: String(d.electiveMinCredits) }); setDetail(d); setItems(Object.fromEntries(d.courses.map((x) => [x.courseId, { category: x.category, suggestedTerm: x.suggestedTerm ? String(x.suggestedTerm) : "" }]))); });
  }, [open, versionId, reloadKey]);
  const columns: Column<MajorRow>[] = [
    { key: "code", header: t("code"), cell: (r) => r.code },
    { key: "name", header: t("name"), cell: (r) => r.name },
    { key: "degree", header: t("degreeType"), cell: (r) => r.degreeType ?? "" },
    { key: "credits", header: t("totalCredits"), cell: (r) => r.totalCredits },
    { key: "actions", header: "", cell: (r) => <Button size="sm" variant="outline" onClick={() => { setVersionId(null); setOpen(r.id); }}>{t("curriculum")}</Button> },
  ];
  return (
    <section>
      <H2>{t("majorsTitle")}</H2>
      <Err error={error} />
      {message}
      <Can perm={PERMS.eduMajorAdd}>{!form ? <IconButton icon={Plus} label={c("add")} onClick={() => setForm(true)} className="mb-3"/> : null}</Can>
      {form ? (
        <FormPanel title={c("add")} fields={[{ name: "code", label: t("code"), required: true }, { name: "name", label: t("name"), required: true }, { name: "degreeType", label: t("degreeType") }, { name: "totalCredits", label: t("totalCredits"), type: "number" }]} submitLabel={c("save")} cancelLabel={c("cancel")} onCancel={() => setForm(false)}
          onSubmit={async (p) => { if (await run(() => bff("majors", { method: "POST", body: p }), c("saved"))) setForm(false); }} />
      ) : null}
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
      {open && detail ? (
        <Modal wide title={t("curriculumOf", { name: detail.name })} onClose={() => { setOpen(null); setDetail(null); setVersionId(null); }}>
        <div className="text-sm">
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">{t("version")}
              <select className="rounded-md border border-border bg-transparent px-2 py-1" value={detail.versionId} onChange={(e) => setVersionId(e.target.value)}>
                {detail.versions.map((v) => <option key={v.id} value={v.id}>{v.label} ({v.entryYearFrom ?? "…"}–{v.entryYearTo ?? "…"}, {v.courseCount})</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">{t("versionYear")}<input type="number" className="w-24 rounded-md border border-border bg-transparent px-2 py-1" value={newYear} onChange={(e) => setNewYear(e.target.value)} /></label>
            <label className="flex flex-col gap-1">{t("versionLabel")}<input className="w-32 rounded-md border border-border bg-transparent px-2 py-1" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} /></label>
            <PermButton perm={PERMS.eduMajorEdit} size="sm" variant="outline" onClick={() => void run(async () => { const r = await bff<{ id: string }>(`majors/${open}/versions`, { method: "POST", body: { effectiveYear: Number(newYear), ...(newLabel ? { label: newLabel } : {}), copyFromVersionId: detail.versionId } }); setNewYear(""); setNewLabel(""); setVersionId(r.id); setReloadKey((k) => k + 1); }, c("saved"))}>{t("versionAdd")}</PermButton>
            {detail.versions.length > 1 ? <PermButton perm={PERMS.eduMajorEdit} size="sm" variant="outline" onClick={() => window.confirm(t("versionConfirmRemove")) && void run(async () => { await bff(`majors/${open}/versions/${detail.versionId}`, { method: "DELETE" }); setVersionId(null); setReloadKey((k) => k + 1); }, c("done"))}>{t("versionRemove")}</PermButton> : null}
          </div>
          <p className="mb-2 text-xs text-muted">{t("versionHelp")}</p>
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">{t("totalCredits")}<input type="number" className="w-24 rounded-md border border-border bg-transparent px-2 py-1" value={credits.total} onChange={(e) => setCredits({ ...credits, total: e.target.value })} /></label>
            <label className="flex flex-col gap-1">{t("electiveMin")}<input type="number" className="w-24 rounded-md border border-border bg-transparent px-2 py-1" value={credits.elective} onChange={(e) => setCredits({ ...credits, elective: e.target.value })} /></label>
            <PermButton perm={PERMS.eduMajorEdit} size="sm" variant="outline" onClick={() => void run(async () => { await bff(`majors/${open}/versions/${detail.versionId}`, { method: "PATCH", body: { totalCredits: Number(credits.total), electiveMinCredits: Number(credits.elective) } }); setReloadKey((k) => k + 1); }, c("saved"))}>{c("save")}</PermButton>
          </div>
          <table className="mb-2 text-left"><tbody>
            {courses.rows.map((x) => (
              <tr key={x.id}>
                <td className="pr-3"><label className="flex items-center gap-1"><input type="checkbox" checked={!!items[x.id]} onChange={(e) => setItems((s) => { const n = { ...s }; if (e.target.checked) n[x.id] = { category: "required", suggestedTerm: "" }; else delete n[x.id]; return n; })} />{x.code} · {x.name}</label></td>
                <td className="pr-3">{items[x.id] ? (
                  <select aria-label={`${x.code} ${t("category")}`} className="rounded-md border border-border bg-transparent px-1" value={items[x.id].category} onChange={(e) => setItems((s) => ({ ...s, [x.id]: { ...s[x.id], category: e.target.value } }))}>
                    {["required", "elective", "general"].map((k) => <option key={k} value={k}>{t(`cat_${k}`)}</option>)}
                  </select>) : null}</td>
                <td>{items[x.id] ? <input aria-label={`${x.code} ${t("suggestedTerm")}`} className="w-14 rounded-md border border-border bg-transparent px-1" placeholder="#" value={items[x.id].suggestedTerm} onChange={(e) => setItems((s) => ({ ...s, [x.id]: { ...s[x.id], suggestedTerm: e.target.value } }))} /> : null}</td>
              </tr>
            ))}
          </tbody></table>
          <PermButton perm={PERMS.eduMajorEdit} size="sm" onClick={() => void run(() => bff(`majors/${open}/courses?version=${detail.versionId}`, { method: "PUT", body: { items: Object.entries(items).map(([courseId, v]) => ({ courseId, category: v.category, suggestedTerm: v.suggestedTerm ? Number(v.suggestedTerm) : null })) } }), c("saved"))}>{c("save")}</PermButton>
          <Button size="sm" variant="outline" className="ml-2" onClick={() => { setOpen(null); setDetail(null); setVersionId(null); }}>{c("close")}</Button>
        </div>
        </Modal>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- 班级
interface SectionRow { id: string; name: string; status: string; capacity: number; seated: number; mode: string; course: { code: string; name: string }; term: { id: string; name: string }; campus: { name: string }; instructors: Array<{ personId: string; fullName: string | null; role: string }> }
interface RosterRow { id: string; fullName: string | null; studentNo: string | null; status: string; method: string }
interface StaffOpt { id: string; fullName: string }
interface StudentOpt { id: string; fullName: string; studentNo: string | null }
interface Material { id: string; title: string; url: string; category: string; published: boolean }
const SEC_NEXT: Record<string, string[]> = { draft: ["open", "cancelled"], open: ["draft", "in_progress", "cancelled"], in_progress: ["ended", "cancelled"], ended: [], cancelled: [] };

export function SectionsPage() {
  const t = useTranslations("pages.edu");
  const c = useTranslations("crud");
  const tt = useTable();
  const sections = useList<SectionRow>("sections");
  const terms = useList<TermRow>("terms");
  const courses = useList<CourseRow>("courses");
  const campuses = useList<{ id: string; name: string; status: string }>("campuses");
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
          <Button size="sm" variant="outline" onClick={() => setOpen(r.id)}>{t("details")}</Button>
          {SEC_NEXT[r.status].map((next) => (
            <PermButton key={next} perm={PERMS.eduSectionStatus} size="sm" variant="outline" onClick={() => (next !== "cancelled" || window.confirm(t("confirmCancel", { name: r.name }))) && void run(() => bff(`sections/${r.id}/status`, { method: "POST", body: { status: next } }), c("done"))}>{t(`to_sec_${next}`)}</PermButton>
          ))}
        </div>
      ),
    },
  ];
  return (
    <section>
      <H2>{t("sectionsTitle")}</H2>
      <Err error={sections.error} />
      {message}
      <Can perm={PERMS.eduSectionAdd}>{!form ? <IconButton icon={Plus} label={c("add")} onClick={() => setForm(true)} className="mb-3"/> : null}</Can>
      <Can perm={PERMS.eduEnrollmentAdd}>{!batchOpen ? <Button size="sm" variant="outline" className="mb-3 ml-2" onClick={() => setBatchOpen(true)}>{t("batchEnroll")}</Button> : null}</Can>
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
function BatchEnrollPanel({ onClose }: { onClose: () => void }) {
  const t = useTranslations("pages.edu");
  const c = useTranslations("crud");
  const terms = useList<TermRow>("terms");
  const courses = useList<CourseRow>("courses");
  const majors = useList<MajorRow>("majors");
  const campuses = useList<{ id: string; name: string; status: string }>("campuses");
  const [f, setF] = React.useState({ termId: "", courseId: "", majorId: "", entryYear: "", campusId: "", reason: "" });
  const [confirm, setConfirm] = React.useState<string[]>([]);
  const [result, setResult] = React.useState<BatchResult | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const body = (dryRun: boolean) => ({ termId: f.termId, courseId: f.courseId, majorId: f.majorId, ...(f.entryYear ? { entryYear: Number(f.entryYear) } : {}), ...(f.campusId ? { campusId: f.campusId } : {}), ...(confirm.length ? { confirm } : {}), ...(f.reason ? { reason: f.reason } : {}), dryRun });
  async function go(dryRun: boolean) {
    try { setMsg(null); setResult(await bff<BatchResult>("enrollment-batches", { method: "POST", body: body(dryRun) })); } catch (e) { setMsg((e as Error).message); }
  }
  const ready = f.termId && f.courseId && f.majorId;
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
        {sel(t("term"), "termId", terms.rows.filter((x) => x.status !== "ended").map((x) => ({ value: x.id, label: x.name })))}
        {sel(t("course"), "courseId", courses.rows.filter((x) => x.status).map((x) => ({ value: x.id, label: `${x.code} · ${x.name}` })))}
        {sel(t("major"), "majorId", majors.rows.filter((x) => x.status).map((x) => ({ value: x.id, label: `${x.code} · ${x.name}` })))}
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
        <Button size="sm" variant="outline" disabled={!ready} onClick={() => void go(true)}>{t("preview")}</Button>
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
  const roster = useList<RosterRow>(`sections/${id}/roster`);
  const materials = useList<Material>(`sections/${id}/materials`);
  const staff = useList<StaffOpt>("staff?size=100");
  const students = useList<StudentOpt>("students?size=100");
  const reloadAll = React.useCallback(() => { void bff<SectionRow>(`sections/${id}`).then(setS); roster.reload(); materials.reload(); }, [id, roster, materials]);
  React.useEffect(() => { void bff<SectionRow>(`sections/${id}`).then(setS); }, [id]);
  const { run, message } = useAct(reloadAll);
  const [pickedStudents, setPickedStudents] = React.useState<string[]>([]);
  const [reason, setReason] = React.useState("");
  const [needs, setNeeds] = React.useState<string[] | null>(null);
  const [teacher, setTeacher] = React.useState("");
  const [matForm, setMatForm] = React.useState(false);
  if (!s) return <Modal title={t("details")} onClose={onClose}><p className="text-sm text-muted">…</p></Modal>;
  async function enroll(confirm?: string[]) {
    const r = await bff<{ results: Array<{ ok: boolean; code?: string; violations?: string[]; message?: string }> }>(`sections/${id}/enrollments`, { method: "POST", body: { studentIds: pickedStudents, confirm, reason: reason || undefined } });
    const need = [...new Set(r.results.flatMap((x) => (x.code === "CONFIRMATION_REQUIRED" ? (x.violations ?? []) : [])))];
    const failed = r.results.filter((x) => !x.ok && x.code !== "CONFIRMATION_REQUIRED");
    if (need.length) setNeeds(need);
    else setNeeds(null);
    if (!need.length && failed.length === 0) { setPickedStudents([]); setReason(""); }
    reloadAll();
    return failed.map((f) => f.message).filter(Boolean).join("; ");
  }
  const rosterCols: Column<RosterRow>[] = [
    { key: "no", header: t("studentNo"), cell: (r) => r.studentNo ?? "" },
    { key: "name", header: t("name"), cell: (r) => r.fullName ?? "" },
    { key: "status", header: c("status"), cell: (r) => t(`enr_${r.status}`) },
    { key: "method", header: t("method"), cell: (r) => (r.method === "registrar" ? t("byRegistrar") : t("bySelf")) },
    { key: "a", header: "", cell: (r) => (r.status === "enrolled" ? <PermButton perm={PERMS.eduEnrollmentRemove} size="sm" variant="outline" onClick={() => void run(() => bff(`sections/${id}/enrollments/${r.id}`, { method: "DELETE" }), c("done"))}>{t("remove")}</PermButton> : null) },
  ];
  return (
    <Modal wide title={`${s.name} — ${s.seated}/${s.capacity}`} onClose={onClose}>
    <div className="text-sm">
      <div role="tablist" className="mb-3 flex gap-2">
        {(["roster", "instructors", "materials", "assignments", "grades", "discussion"] as const).filter((k) => (k !== "assignments" || perms.has(PERMS.eduAssignmentList)) && (k !== "grades" || perms.has(PERMS.eduGradeList)) && (k !== "discussion" || perms.has(PERMS.eduDiscussionList))).map((k) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "font-medium underline" : "text-muted"} onClick={() => setTab(k)}>{t(`tab_${k}`)}</button>)}
      </div>
      {message}
      {tab === "roster" ? (
        <div>
          <Can perm={PERMS.eduEnrollmentAdd}>
            <div className="mb-3 rounded-md border border-border p-2">
              <p className="mb-1 text-muted">{t("addStudents")}</p>
              <div className="mb-2 flex max-h-32 flex-wrap gap-3 overflow-auto">
                {students.rows.map((x) => <label key={x.id} className="flex items-center gap-1"><input type="checkbox" checked={pickedStudents.includes(x.id)} onChange={(e) => setPickedStudents(e.target.checked ? [...pickedStudents, x.id] : pickedStudents.filter((y) => y !== x.id))} />{x.fullName} ({x.studentNo})</label>)}
              </div>
              {needs ? <p role="alert" className="mb-1 text-red-600">{t("needConfirm", { list: needs.map((n) => t(`viol_${n}`)).join(", ") })}</p> : null}
              {needs ? <label className="mb-2 flex flex-col gap-1">{t("reason")}<input className="rounded-md border border-border bg-transparent px-2 py-1" value={reason} onChange={(e) => setReason(e.target.value)} /></label> : null}
              <PermButton perm={PERMS.eduEnrollmentAdd} size="sm" disabled={pickedStudents.length === 0 || (needs !== null && !reason.trim())} onClick={() => void enroll(needs ?? undefined).catch(() => undefined)}>{needs ? t("confirmEnroll") : t("enroll")}</PermButton>
            </div>
          </Can>
          <DataTable columns={rosterCols} rows={roster.rows} rowKey={(r) => r.id} loading={roster.loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
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
      {tab === "materials" ? (
        <div>
          <ul className="mb-2 list-disc pl-5">{materials.rows.map((m) => (
            <li key={m.id}><a className="underline" href={m.url} target="_blank" rel="noopener noreferrer">{m.title}</a> {m.published ? "" : `(${t("draft")})`}
              <PermButton perm={PERMS.eduMaterialEdit} size="sm" variant="outline" className="ml-2" onClick={() => void run(() => bff(`sections/${id}/materials/${m.id}`, { method: "DELETE" }), c("done"))}>{c("delete")}</PermButton></li>
          ))}</ul>
          <Can perm={PERMS.eduMaterialEdit}>
            {matForm ? (
              <FormPanel inline title={c("add")} fields={[{ name: "title", label: t("name"), required: true }, { name: "url", label: t("url"), required: true }, { name: "published", label: t("published"), type: "checkbox" }]} submitLabel={c("save")} cancelLabel={c("cancel")} onCancel={() => setMatForm(false)}
                onSubmit={async (p) => { if (await run(() => bff(`sections/${id}/materials`, { method: "POST", body: p }), c("saved"))) setMatForm(false); }} />
            ) : <IconButton icon={Plus} label={c("add")} onClick={() => setMatForm(true)}/>}
          </Can>
        </div>
      ) : null}
      {tab === "assignments" ? <AssignmentsPanel sectionId={id} /> : null}
      {tab === "grades" ? <GradesPanel sectionId={id} /> : null}
      {tab === "discussion" ? <DiscussionPanel sectionId={id} /> : null}
      <div className="mt-4 border-t border-border pt-3"><Button size="sm" variant="outline" onClick={onClose}>{c("close")}</Button></div>
    </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- 学生门户：选课
interface OpenSection { id: string; name: string; course: { code: string; name: string; credits: number }; campus: string; seatsLeft: number; capacity: number; requirement: string | null; prerequisitesMet: boolean; missingPrerequisites: string[]; conflicts: string[]; alreadyTaking: boolean; alreadyPassed: boolean; instructors: Array<{ fullName: string | null }> }
interface MyEnrollment { id: string; status: string; course: { code: string; name: string }; term: string; canDrop: boolean; willBeW: boolean; section: { id: string; name: string } }

export function PortalEnrollPage() {
  const t = useTranslations("pages.edu");
  const c = useTranslations("crud");
  const [filter, setFilter] = React.useState<"mine" | "all">("all");
  const [data, setData] = React.useState<{ declaredMajor: { name: string } | null; sections: OpenSection[] } | null>(null);
  const [enrolled, setEnrolled] = React.useState<MyEnrollment[]>([]);
  const [msg, setMsg] = React.useState<{ text: string; error: boolean } | null>(null);
  const load = React.useCallback(() => {
    void bff<{ declaredMajor: { name: string } | null; sections: OpenSection[] }>(`sections?filter=${filter}`).then(setData);
    void bff<MyEnrollment[]>("my-enrollments").then(setEnrolled);
  }, [filter]);
  React.useEffect(load, [load]);
  async function act(fn: () => Promise<unknown>, ok: string) {
    try { const r = await fn(); const conflicts = (r as { conflicts?: Array<{ name: string }> })?.conflicts ?? []; setMsg({ text: conflicts.length ? `${ok} ${t("clashWarning", { list: conflicts.map((x) => x.name).join(", ") })}` : ok, error: false }); } catch (e) { setMsg({ text: (e as Error).message, error: true }); }
    load();
  }
  if (!data) return <p className="text-sm text-muted">…</p>;
  return (
    <section>
      <H2>{t("enrollTitle")}</H2>
      {!data.declaredMajor ? <p className="mb-2 text-sm text-muted">{t("declareFirst")}</p> : null}
      {msg ? <p role={msg.error ? "alert" : "status"} className={`mb-2 text-sm ${msg.error ? "text-red-600" : "text-muted"}`}>{msg.text}</p> : null}
      <h3 className="mb-1 font-medium">{t("myCourses")}</h3>
      <ul className="mb-4 list-disc pl-5 text-sm">
        {enrolled.length === 0 ? <li className="text-muted">—</li> : enrolled.map((e) => (
          <li key={e.id}>{e.course.code} · {e.course.name} ({e.term}) — {t(`enr_${e.status}`)}
            {e.canDrop ? <PermButton perm={PERMS.portalEnrollDrop} size="sm" variant="outline" className="ml-2" onClick={() => window.confirm(e.willBeW ? t("confirmDropW") : t("confirmDrop")) && void act(() => bff(`enrollments/${e.id}`, { method: "DELETE" }), c("done"))}>{t("drop")}</PermButton> : null}</li>
        ))}
      </ul>
      <div className="mb-2 flex items-center gap-2 text-sm">
        <h3 className="font-medium">{t("openSections")}</h3>
        <select aria-label={t("filter")} className="rounded-md border border-border bg-transparent px-2 py-1" value={filter} onChange={(e) => setFilter(e.target.value as "mine" | "all")}><option value="all">{t("allCourses")}</option><option value="mine">{t("myMajorOnly")}</option></select>
      </div>
      <ul className="space-y-2 text-sm">
        {data.sections.map((s) => (
          <li key={s.id} className="rounded-md border border-border p-2">
            <div className="font-medium">{s.course.code} · {s.course.name} <span className="text-muted">({s.course.credits})</span> {s.requirement ? <span className="ml-1 rounded bg-border/50 px-1">{t(`cat_${s.requirement}`)}</span> : null}</div>
            <div className="text-muted">{s.name} · {s.campus} · {t("seatsLeft", { n: s.seatsLeft })} · {s.instructors.map((i) => i.fullName).filter(Boolean).join(", ")}</div>
            {!s.prerequisitesMet ? <div className="text-red-600">{t("missingPrereq", { list: s.missingPrerequisites.join(", ") })}</div> : null}
            {s.conflicts.length ? <div className="text-amber-600">{t("clashWarning", { list: s.conflicts.join(", ") })}</div> : null}
            <PermButton perm={PERMS.portalEnrollAdd} size="sm" className="mt-1" disabled={s.alreadyTaking || s.seatsLeft === 0} onClick={() => void act(() => bff("enrollments", { method: "POST", body: { sectionId: s.id } }), t("enrolledOk"))}>{s.alreadyTaking ? t("taking") : s.seatsLeft === 0 ? t("full") : t("enroll")}</PermButton>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- 学生门户：培养方案
interface Plan { declaredMajor: { name: string } | null; message?: string; courses: Array<{ courseId: string; code: string; name: string; credits: number; category: string; suggestedTerm: number | null; state: string }>; credits: { earned: number; required: number } }

export function PortalPlanPage() {
  const t = useTranslations("pages.edu");
  const [plan, setPlan] = React.useState<Plan | null>(null);
  React.useEffect(() => { void bff<Plan>("plan").then(setPlan); }, []);
  if (!plan) return <p className="text-sm text-muted">…</p>;
  return (
    <section>
      <H2>{t("planTitle")}</H2>
      {!plan.declaredMajor ? <p className="text-sm text-muted">{t("declareFirst")}</p> : (
        <>
          <p className="mb-2 text-sm">{plan.declaredMajor.name} — {t("progress", { earned: plan.credits.earned, required: plan.credits.required })}</p>
          <p className="mb-2 text-xs text-muted">{t("planNote")}</p>
          <table className="w-full text-left text-sm">
            <thead className="text-muted"><tr><th className="py-1">{t("code")}</th><th>{t("name")}</th><th>{t("credits")}</th><th>{t("category")}</th><th>{t("suggestedTerm")}</th><th>{t("state")}</th></tr></thead>
            <tbody>{plan.courses.map((x) => <tr key={x.courseId} className="border-t border-border"><td className="py-1">{x.code}</td><td>{x.name}</td><td>{x.credits}</td><td>{t(`cat_${x.category}`)}</td><td>{x.suggestedTerm ?? ""}</td><td>{t(`state_${x.state}`)}</td></tr>)}</tbody>
          </table>
        </>
      )}
    </section>
  );
}
