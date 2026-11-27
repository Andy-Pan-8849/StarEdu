"use client";

// 教务的专业窗口：详情（只读）和编辑，都是"基本信息"和"培养方案"两个页签。
// 培养方案：版本（学分要求、新增 / 删除版本）+ 课程列表；课程用"+"打开搜索窗口来加，加 / 删 / 改类别 / 改建议学期都立刻保存。
import { useTranslations } from "next-intl";
import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { PERMS } from "@staredu/shared";
import { Button } from "@/components/ui/button";
import { bff } from "@/lib/bff";
import { Modal } from "../modal";
import { DataTable, type Column } from "../data-table";
import { Can, PermButton, usePermissions } from "../permissions";
import { IconButton, PermRowAction, RowAction } from "../icon-button";
import { TabBody, Tabs } from "../tabs";
import { useDict } from "../use-dict";
import { FormPanel, useAct, type Field } from "./crud";
import { CoursePicker } from "./course-dialogs";
import { useTable } from "./use-table";

export interface MajorRow { id: string; code: string; name: string; degreeType: string | null; totalCredits: number; status: boolean }
interface VersionRow { id: string; label: string; effectiveYear: number; entryYearFrom: number | null; entryYearTo: number | null; courseCount: number | null }
interface CurriculumCourse { courseId: string; code: string; name: string; credits: number; category: string; suggestedTerm: number | null }
interface MajorDetail { id: string; name: string; versionId: string; totalCredits: number; electiveMinCredits: number; versions: VersionRow[]; courses: CurriculumCourse[] }
const CATEGORIES = ["required", "elective", "general"];
const input = "rounded-md border border-border bg-transparent px-2 py-1";
const BODY = "h-[calc(88vh-13rem)]";

function CurriculumTab({ majorId, editable }: { majorId: string; editable: boolean }) {
  const t = useTranslations("pages.edu");
  const c = useTranslations("crud");
  const tbl = useTable();
  const [versionId, setVersionId] = React.useState<string | null>(null);
  const [d, setD] = React.useState<MajorDetail | null>(null);
  const [key, setKey] = React.useState(0);
  const [credits, setCredits] = React.useState({ total: "", elective: "" });
  const [newYear, setNewYear] = React.useState("");
  const [newLabel, setNewLabel] = React.useState("");
  const [picking, setPicking] = React.useState(false);
  const reload = React.useCallback(() => setKey((k) => k + 1), []);
  const { run, message } = useAct(reload);
  React.useEffect(() => {
    void bff<MajorDetail>(`majors/${majorId}${versionId ? `?version=${versionId}` : ""}`).then((x) => { setD(x); setCredits({ total: String(x.totalCredits), elective: String(x.electiveMinCredits) }); });
  }, [majorId, versionId, key]);
  if (!d) return <p className="text-sm text-muted">…</p>;

  const saveCourses = (items: CurriculumCourse[]) => run(() => bff(`majors/${majorId}/courses?version=${d.versionId}`, { method: "PUT", body: { items: items.map((x) => ({ courseId: x.courseId, category: x.category, suggestedTerm: x.suggestedTerm })) } }));
  const change = (courseId: string, patch: Partial<CurriculumCourse>) => void saveCourses(d.courses.map((x) => (x.courseId === courseId ? { ...x, ...patch } : x)));
  const cols: Column<CurriculumCourse>[] = [
    { key: "code", header: t("code"), cell: (r) => r.code },
    { key: "name", header: t("name"), cell: (r) => r.name },
    { key: "credits", header: t("credits"), cell: (r) => r.credits },
    { key: "category", header: t("category"), cell: (r) => (editable ? (
      <select aria-label={`${r.code} ${t("category")}`} className={input} value={r.category} onChange={(e) => change(r.courseId, { category: e.target.value })}>
        {CATEGORIES.map((k) => <option key={k} value={k}>{t(`cat_${k}`)}</option>)}
      </select>) : t(`cat_${r.category}`)) },
    { key: "term", header: t("suggestedTerm"), cell: (r) => (editable ? (
      <input aria-label={`${r.code} ${t("suggestedTerm")}`} className={`${input} w-16`} placeholder="#" defaultValue={r.suggestedTerm ?? ""} onBlur={(e) => { const v = e.target.value.trim(); const n = v ? Number(v) : null; if (n !== r.suggestedTerm && (n === null || Number.isInteger(n))) change(r.courseId, { suggestedTerm: n }); }} />) : (r.suggestedTerm ?? "—")) },
    ...(editable ? [{ key: "actions", header: "", cell: (r: CurriculumCourse) => <RowAction icon={Trash2} danger onClick={() => void saveCourses(d.courses.filter((x) => x.courseId !== r.courseId))}>{t("removeCourse")}</RowAction> } as Column<CurriculumCourse>] : []),
  ];
  const current = d.versions.find((v) => v.id === d.versionId);
  return (
    <div className="flex h-full flex-col text-sm">
      <div className="shrink-0">
        <div className="mb-2 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">{t("version")}
            <select className={input} value={d.versionId} onChange={(e) => setVersionId(e.target.value)}>
              {d.versions.map((v) => <option key={v.id} value={v.id}>{v.label} ({v.entryYearFrom ?? "…"}–{v.entryYearTo ?? "…"}, {v.courseCount})</option>)}
            </select>
          </label>
          {editable ? (
            <>
              <label className="flex flex-col gap-1">{t("versionYear")}<input type="number" className={`${input} w-24`} value={newYear} onChange={(e) => setNewYear(e.target.value)} /></label>
              <label className="flex flex-col gap-1">{t("versionLabel")}<input className={`${input} w-32`} value={newLabel} onChange={(e) => setNewLabel(e.target.value)} /></label>
              <PermRowAction perm={PERMS.eduMajorEdit} disabled={!newYear} icon={Plus} onClick={() => void run(async () => { const r = await bff<{ id: string }>(`majors/${majorId}/versions`, { method: "POST", body: { effectiveYear: Number(newYear), ...(newLabel ? { label: newLabel } : {}), copyFromVersionId: d.versionId } }); setNewYear(""); setNewLabel(""); setVersionId(r.id); }, c("saved"))}>{t("versionAdd")}</PermRowAction>
              {d.versions.length > 1 ? <PermRowAction perm={PERMS.eduMajorEdit} icon={Trash2} danger onClick={() => window.confirm(t("versionConfirmRemove")) && void run(async () => { await bff(`majors/${majorId}/versions/${d.versionId}`, { method: "DELETE" }); setVersionId(null); }, c("done"))}>{t("versionRemove")}</PermRowAction> : null}
            </>
          ) : null}
        </div>
        <p className="mb-2 text-xs text-muted">{t("versionHelp")}</p>
        <div className="mb-3 flex flex-wrap items-end gap-4">
          {editable ? (
            <>
              <label className="flex flex-col gap-1">{t("totalCredits")}<input type="number" className={`${input} w-24`} value={credits.total} onChange={(e) => setCredits({ ...credits, total: e.target.value })} /></label>
              <label className="flex flex-col gap-1">{t("electiveMin")}<input type="number" className={`${input} w-24`} value={credits.elective} onChange={(e) => setCredits({ ...credits, elective: e.target.value })} /></label>
              <PermButton perm={PERMS.eduMajorEdit} size="sm" variant="outline" onClick={() => void run(() => bff(`majors/${majorId}/versions/${d.versionId}`, { method: "PATCH", body: { totalCredits: Number(credits.total), electiveMinCredits: Number(credits.elective) } }), c("saved"))}>{c("save")}</PermButton>
            </>
          ) : (
            <dl className="flex gap-6">
              <div><dt className="text-muted">{t("totalCredits")}</dt><dd>{d.totalCredits}</dd></div>
              <div><dt className="text-muted">{t("electiveMin")}</dt><dd>{d.electiveMinCredits}</dd></div>
              {current ? <div><dt className="text-muted">{t("versionYear")}</dt><dd>{current.effectiveYear}</dd></div> : null}
            </dl>
          )}
        </div>
        <div className="mb-2 flex items-center gap-2">
          <h3 className="font-medium">{t("curriculumCourses")}</h3>
          {editable ? <Can perm={PERMS.eduMajorEdit}><IconButton icon={Plus} label={t("addCourse")} onClick={() => setPicking(true)} /></Can> : null}
        </div>
        {message}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DataTable columns={cols} rows={d.courses} rowKey={(r) => r.courseId} emptyText={t("noCurriculumCourses")} loadingText={tbl.loading} selectable={false} labels={tbl.labels} />
      </div>
      {picking ? <CoursePicker title={t("pickCurriculumCourse")} exclude={d.courses.map((x) => x.courseId)} onClose={() => setPicking(false)} onPick={(p) => { setPicking(false); void saveCourses([...d.courses, { courseId: p.id, code: p.code, name: p.name, credits: p.credits, category: "required", suggestedTerm: null }]); }} /> : null}
    </div>
  );
}

/** 详情（mode="view"，只读）和编辑（mode="edit"）。 */
export function MajorDialog({ row, mode, onClose, onSaved }: { row: MajorRow; mode: "view" | "edit"; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("pages.edu");
  const c = useTranslations("crud");
  const perms = usePermissions();
  const degrees = useDict("degree_type");
  const [tab, setTab] = React.useState<"basic" | "curriculum">("basic");
  const { run } = useAct(() => undefined);
  const editable = mode === "edit" && perms.has(PERMS.eduMajorEdit);
  const fields: Field[] = [
    { name: "code", label: t("code"), readOnly: true },
    { name: "name", label: t("name"), required: true },
    { name: "degreeType", label: t("degreeType"), type: "select", options: row.degreeType && !degrees.options.some((o) => o.value === row.degreeType) ? [...degrees.options, { value: row.degreeType, label: row.degreeType }] : degrees.options },
    { name: "totalCredits", label: t("totalCredits"), type: "number" },
  ];
  const item = (label: string, value: React.ReactNode) => <div className="grid grid-cols-[10rem_1fr] gap-2"><dt className="text-muted">{label}</dt><dd>{value}</dd></div>;
  return (
    <Modal wide title={`${row.code} · ${row.name}`} onClose={onClose}>
      <Tabs value={tab} onChange={setTab} items={[{ key: "basic", label: t("tabBasic") }, { key: "curriculum", label: t("curriculum") }]} />
      <TabBody className={BODY}>
        {tab === "basic" ? (
          editable ? (
            <FormPanel inline fill title={t("tabBasic")} fields={fields} submitLabel={c("save")} cancelLabel={c("cancel")} onCancel={onClose}
              initial={{ code: row.code, name: row.name, degreeType: row.degreeType ?? "", totalCredits: String(row.totalCredits) }}
              onSubmit={async (p) => { const { code: _code, ...body } = p; void _code; if (await run(() => bff(`majors/${row.id}`, { method: "PATCH", body }))) { onSaved(); onClose(); } }} />
          ) : (
            <dl className="space-y-2 text-sm">
              {item(t("code"), row.code)}
              {item(t("name"), row.name)}
              {item(t("degreeType"), degrees.label(row.degreeType) || "—")}
              {item(t("totalCredits"), row.totalCredits)}
              {item(c("status"), row.status ? c("enabled") : c("disabled"))}
            </dl>
          )
        ) : <CurriculumTab majorId={row.id} editable={editable} />}
      </TabBody>
      {!editable ? <div className="mt-3 border-t border-border pt-3"><Button size="sm" variant="outline" onClick={onClose}>{c("close")}</Button></div> : null}
    </Modal>
  );
}
