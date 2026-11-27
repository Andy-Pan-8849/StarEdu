"use client";

// 教务的课程窗口：详情（只读）和编辑（基本信息、先修课两个页签）。先修课是列表，"+"打开另一个窗口按课程编号 / 名称搜索再选，
// 不会一次把全部课程取出来（课程很多时数据量大、查询也频繁）。
import { useTranslations } from "next-intl";
import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { PERMS } from "@staredu/shared";
import { Button } from "@/components/ui/button";
import { bff } from "@/lib/bff";
import { Modal } from "../modal";
import { DataTable, type Column } from "../data-table";
import { Can, usePermissions } from "../permissions";
import { IconButton, RowAction } from "../icon-button";
import { TabBody, Tabs } from "../tabs";
import { FormPanel, useAct, type Field } from "./crud";
import { useTable } from "./use-table";

export const PICK_LIMIT = 20;
export interface CoursePick { id: string; code: string; name: string; credits: number }
interface CourseFull { id: string; code: string; name: string; credits: number; syllabus: string | null; status: boolean; prerequisites: CoursePick[]; majors: Array<{ code: string; name: string; category: string }>; sections: Array<{ id: string; name: string; status: string }> }

/** 选课程（先修课、专业课程设置共用）：搜索框 + 最多 PICK_LIMIT 条结果，勾选后"添加所选"，添加完关闭窗口；"取消"不改任何东西直接退出。 */
export function CoursePicker({ title, exclude, onPick, onClose }: { title: string; exclude: string[]; onPick: (courses: CoursePick[]) => Promise<unknown> | void; onClose: () => void }) {
  const t = useTranslations("pages.edu");
  const tbl = useTable();
  const [q, setQ] = React.useState("");
  const [rows, setRows] = React.useState<CoursePick[] | null>(null);
  const [picked, setPicked] = React.useState<CoursePick[]>([]); // 跨搜索保留：换个关键字再搜，之前勾的还在
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void bff<CoursePick[]>(`courses?status=enabled&limit=${PICK_LIMIT}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`).then((r) => { if (live) setRows(r); }).catch(() => { if (live) setRows([]); });
    }, q ? 250 : 0); // 打字时稍等一下再查，免得每敲一个字就查一次
    return () => { live = false; clearTimeout(timer); };
  }, [q]);
  const shown = (rows ?? []).filter((r) => !exclude.includes(r.id));
  const has = (id: string) => picked.some((p) => p.id === id);
  const cols: Column<CoursePick>[] = [
    { key: "pick", header: "", cell: (r) => <input type="checkbox" aria-label={r.code} checked={has(r.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, r] : picked.filter((p) => p.id !== r.id))} /> },
    { key: "code", header: t("code"), cell: (r) => r.code },
    { key: "name", header: t("name"), cell: (r) => r.name },
    { key: "credits", header: t("credits"), cell: (r) => r.credits },
  ];
  async function addPicked() {
    setBusy(true);
    try {
      const ok = await onPick(picked);
      if (ok !== false) onClose(); // 保存失败（比如先修课成环）时窗口留着，错误显示在窗口里
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal wide title={title} onClose={onClose}>
      <div className="min-h-[24rem] space-y-3 text-sm">
        <input aria-label={t("searchCourses")} placeholder={t("searchCourses")} className="w-full rounded-md border border-border bg-transparent px-2 py-1" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <DataTable columns={cols} rows={shown} rowKey={(r) => r.id} loading={rows === null} emptyText={t("noMatches")} loadingText={tbl.loading} selectable={false} labels={tbl.labels} />
        {rows && rows.length >= PICK_LIMIT ? <p className="text-xs text-muted">{t("searchHint", { n: PICK_LIMIT })}</p> : null}
        <div className="flex items-center gap-2 border-t border-border pt-3">
          <Button size="sm" disabled={busy || picked.length === 0} onClick={() => void addPicked()}>{t("addSelected", { n: picked.length })}</Button>
          <Button size="sm" variant="outline" onClick={onClose}>{t("cancelPick")}</Button>
        </div>
      </div>
    </Modal>
  );
}

/** 先修课页签：列表；编辑时有"+"和每行的移除，改动立刻保存。 */
function PrereqTab({ course, editable, onChanged }: { course: CourseFull; editable: boolean; onChanged: () => void }) {
  const t = useTranslations("pages.edu");
  const tbl = useTable();
  const { run, message } = useAct(onChanged);
  const [picking, setPicking] = React.useState(false);
  const save = (ids: string[]) => run(() => bff(`courses/${course.id}/prerequisites`, { method: "PUT", body: { courseIds: ids } }));
  const cols: Column<CoursePick>[] = [
    { key: "code", header: t("code"), cell: (r) => r.code },
    { key: "name", header: t("name"), cell: (r) => r.name },
    { key: "credits", header: t("credits"), cell: (r) => r.credits },
    ...(editable ? [{ key: "actions", header: "", cell: (r: CoursePick) => <RowAction icon={Trash2} danger onClick={() => void save(course.prerequisites.filter((p) => p.id !== r.id).map((p) => p.id))}>{t("removePrereq")}</RowAction> } as Column<CoursePick>] : []),
  ];
  return (
    <div className="text-sm">
      <p className="mb-2 text-muted">{t("prerequisites")}</p>
      {editable ? <Can perm={PERMS.eduCourseEdit}><IconButton icon={Plus} label={t("addPrereq")} className="mb-3" onClick={() => setPicking(true)} /></Can> : null}
      {message}
      <DataTable columns={cols} rows={course.prerequisites} rowKey={(r) => r.id} emptyText={t("noPrereqs")} loadingText={tbl.loading} selectable={false} labels={tbl.labels} />
      {picking ? <CoursePicker title={t("pickPrereq")} exclude={[course.id, ...course.prerequisites.map((p) => p.id)]} onClose={() => setPicking(false)} onPick={(list) => save([...course.prerequisites.map((p) => p.id), ...list.map((c) => c.id)])} /> : null}
    </div>
  );
}

/** 详情（mode="view"，全是只读文字）和编辑（mode="edit"）。 */
export function CourseDialog({ id, mode, onClose, onSaved }: { id: string; mode: "view" | "edit"; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("pages.edu");
  const c = useTranslations("crud");
  const perms = usePermissions();
  const [tab, setTab] = React.useState<"basic" | "prereq">("basic");
  const [d, setD] = React.useState<CourseFull | null>(null);
  const load = React.useCallback(() => { void bff<CourseFull>(`courses/${id}`).then(setD); }, [id]);
  React.useEffect(load, [load]);
  const { run } = useAct(() => undefined);
  const editable = mode === "edit" && perms.has(PERMS.eduCourseEdit);
  if (!d) return <Modal wide title={t("details")} onClose={onClose}><p className="text-sm text-muted">…</p></Modal>;

  const locked = d.sections.length > 0; // 有了历史班级以后，编号和学分只读
  const fields: Field[] = [
    { name: "code", label: t("code"), required: true, readOnly: locked, hint: locked ? t("codeLocked") : undefined },
    { name: "name", label: t("name"), required: true },
    { name: "credits", label: t("credits"), type: "number", required: true, readOnly: locked },
    { name: "syllabus", label: t("syllabusField"), type: "textarea" },
    { name: "status", label: c("enabled"), type: "checkbox" },
  ];
  const row = (label: string, value: React.ReactNode) => <div className="grid grid-cols-[10rem_1fr] gap-2"><dt className="text-muted">{label}</dt><dd className="whitespace-pre-wrap">{value}</dd></div>;
  return (
    <Modal wide title={`${d.code} · ${d.name}`} onClose={onClose}>
      <Tabs value={tab} onChange={setTab} items={[{ key: "basic", label: t("tabBasic") }, { key: "prereq", label: t("tabPrereq") }]} />
      <TabBody className="h-[calc(88vh-13rem)]">
        {tab === "basic" ? (
          editable ? (
            <FormPanel inline fill title={t("tabBasic")} fields={fields} submitLabel={c("save")} cancelLabel={c("cancel")} onCancel={onClose}
              initial={{ code: d.code, name: d.name, credits: String(d.credits), syllabus: d.syllabus ?? "", status: d.status }}
              onSubmit={async (p) => { if (await run(() => bff(`courses/${id}`, { method: "PATCH", body: p }))) { onSaved(); onClose(); } }} />
          ) : (
            <dl className="space-y-2 text-sm">
              {row(t("code"), d.code)}
              {row(t("name"), d.name)}
              {row(t("credits"), d.credits)}
              {row(c("status"), d.status ? c("enabled") : c("disabled"))}
              {row(t("syllabusField"), d.syllabus?.trim() ? d.syllabus : "—")}
              {row(t("appliesTo"), d.majors.map((m) => `${m.name} (${t(`cat_${m.category}`)})`).join(", ") || "—")}
              {row(t("history"), d.sections.map((s) => s.name).join(", ") || "—")}
            </dl>
          )
        ) : <PrereqTab course={d} editable={editable} onChanged={() => { load(); onSaved(); }} />}
      </TabBody>
      {!editable ? <div className="mt-3 border-t border-border pt-3"><Button size="sm" variant="outline" onClick={onClose}>{c("close")}</Button></div> : null}
    </Modal>
  );
}
