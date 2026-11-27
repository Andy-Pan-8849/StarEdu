"use client";

// 学生门户：培养方案（Degree plan）。一页：专业选择（只列自己的专业）、专业信息、学分进度、课程表；点课程名看课程信息。
// 状态只有 未开始 / 进行中 / 已通过，由服务端按当前的选课记录实时算；不判断"能不能修"，修什么由学生自己规划。
import { useTranslations } from "next-intl";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { bff } from "@/lib/bff";
import { Modal } from "../modal";
import { DataTable, type Column } from "../data-table";
import { useDict } from "../use-dict";
import { useTable } from "./use-table";
import { CourseLink } from "./course-pages";

interface Prereq { code: string; name: string; passed: boolean }
interface PlanCourse { courseId: string; code: string; name: string; credits: number; category: string; state: "not_started" | "in_progress" | "passed"; prerequisites: Prereq[] }
interface Plan {
  majors: Array<{ id: string; name: string; kind: string }>;
  selected: null | {
    id: string; kind: string; code: string; name: string; degreeType: string | null; department: string | null; description: string | null;
    entryYear: number; declaredOn: string; version: { label: string; effectiveYear: number } | null;
  };
  credits: { earned: number; required: number };
  categories: Array<{ category: string; earned: number; planned: number }>;
  elective: { earned: number; min: number };
  courses: PlanCourse[];
}
interface CourseInfo { id: string; code: string; name: string; credits: number; syllabus: string | null; prerequisites: Prereq[]; majors: Array<{ id: string; name: string; category: string }> }

const STATE_STYLE: Record<PlanCourse["state"], string> = {
  passed: "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300",
  in_progress: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  not_started: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
};

/** 前置课：代码列表，学生已通过的打勾（这是事实，不是"能不能修"的判断）。 */
function Prereqs({ items, none }: { items: Prereq[]; none: string }) {
  if (items.length === 0) return <span className="text-muted">{none}</span>;
  return <span>{items.map((p, i) => <React.Fragment key={p.code}>{i > 0 ? ", " : ""}<span title={p.name}>{p.code}{p.passed ? <span aria-label="passed" className="text-green-700"> ✓</span> : null}</span></React.Fragment>)}</span>;
}

/** 课程信息：点培养方案里的课程名打开。学分、简介、前置课、在我各个专业里的类别。 */
export function CourseInfoDialog({ courseId, onClose }: { courseId: string; onClose: () => void }) {
  const t = useTranslations("pages.courseInfo");
  const te = useTranslations("pages.edu");
  const c = useTranslations("crud");
  const [d, setD] = React.useState<CourseInfo | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => { void bff<CourseInfo>(`courses/${courseId}`).then(setD).catch((e: Error) => setError(e.message)); }, [courseId]);
  const row = (label: string, value: React.ReactNode) => (<div className="grid grid-cols-[8rem_1fr] gap-2"><dt className="text-muted">{label}</dt><dd>{value}</dd></div>);
  return (
    <Modal title={d ? `${d.code} · ${d.name}` : t("title")} onClose={onClose}>
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : !d ? <p className="text-sm text-muted">…</p> : (
        <div className="space-y-3 text-sm">
          <dl className="space-y-1.5">
            {row(t("credits"), d.credits)}
            {row(t("category"), d.majors.length === 0 ? "—" : (<ul>{d.majors.map((m) => <li key={m.id}>{m.name}: {te(`cat_${m.category}`)}</li>)}</ul>))}
            {row(t("prerequisites"), d.prerequisites.length === 0 ? t("none") : (<ul>{d.prerequisites.map((p) => <li key={p.code}>{p.code} · {p.name}{p.passed ? <span className="text-green-700"> ✓ {t("passed")}</span> : null}</li>)}</ul>))}
          </dl>
          <div>
            <h3 className="mb-1 font-medium">{t("syllabus")}</h3>
            <p className="whitespace-pre-wrap text-muted">{d.syllabus?.trim() ? d.syllabus : t("noSyllabus")}</p>
          </div>
          <div className="border-t border-border pt-3"><Button size="sm" variant="outline" onClick={onClose}>{c("close")}</Button></div>
        </div>
      )}
    </Modal>
  );
}

export function PortalPlanPage() {
  const t = useTranslations("pages.plan");
  const te = useTranslations("pages.edu");
  const tbl = useTable();
  const degrees = useDict("degree_type");
  const [plan, setPlan] = React.useState<Plan | null>(null);
  const [majorId, setMajorId] = React.useState(""); // "" = 默认（主修）
  const [error, setError] = React.useState<string | null>(null);
  const [info, setInfo] = React.useState<string | null>(null);
  React.useEffect(() => {
    let live = true;
    bff<Plan>(`plan${majorId ? `?majorId=${majorId}` : ""}`).then((p) => { if (live) { setPlan(p); setError(null); } }).catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [majorId]);

  if (error) return <p role="alert" className="text-sm text-red-600">{error}</p>;
  if (!plan) return <p className="text-sm text-muted">…</p>;
  const m = plan.selected;
  if (!m) {
    return (
      <section className="text-sm">
        <h2 className="mb-3 text-lg font-semibold">{t("title")}</h2>
        <p role="status" className="rounded-md border border-border bg-border/20 px-3 py-2">{t("noMajor")}</p>
      </section>
    );
  }
  const pct = plan.credits.required > 0 ? Math.min(100, Math.round((plan.credits.earned / plan.credits.required) * 100)) : 0;
  const columns: Column<PlanCourse>[] = [
    { key: "course", header: t("colCourse"), cell: (x) => <CourseLink onOpen={() => setInfo(x.courseId)}>{x.code} · {x.name}</CourseLink> },
    { key: "category", header: t("colCategory"), cell: (x) => te(`cat_${x.category}`) },
    { key: "credits", header: t("colCredits"), cell: (x) => x.credits },
    { key: "prereq", header: t("colPrereq"), cell: (x) => <Prereqs items={x.prerequisites} none="—" /> },
    { key: "state", header: t("colState"), cell: (x) => <span className={`rounded px-2 py-0.5 text-xs ${STATE_STYLE[x.state]}`}>{t(`state_${x.state}`)}</span> },
  ];
  const fact = (label: string, value: React.ReactNode) => (value ? <div><dt className="text-xs text-muted">{label}</dt><dd>{value}</dd></div> : null);
  return (
    <section className="space-y-4 text-sm">
      <h2 className="text-lg font-semibold">{t("title")}</h2>
      {plan.majors.length > 1 ? (
        <label className="flex items-center gap-2">
          {t("major")}
          <select aria-label={t("major")} className="rounded-md border border-border bg-transparent px-2 py-1" value={m.id} onChange={(e) => setMajorId(e.target.value)}>
            {plan.majors.map((x) => <option key={x.id} value={x.id}>{x.name} ({t(`kind_${x.kind}`)})</option>)}
          </select>
        </label>
      ) : null}

      <div className="rounded-lg border border-border p-4">
        <h3 className="mb-2 font-medium">{t("majorInfo")}</h3>
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
          {fact(t("majorName"), `${m.name} (${m.code})`)}
          {fact(t("kind"), t(`kind_${m.kind}`))}
          {fact(t("degreeType"), degrees.label(m.degreeType))}
          {fact(t("department"), m.department)}
          {fact(t("planVersion"), m.version ? `${m.version.label} (${m.version.effectiveYear})` : null)}
          {fact(t("entryYear"), m.entryYear)}
          {fact(t("declaredOn"), m.declaredOn)}
          {fact(t("requiredCredits"), plan.credits.required)}
          {fact(t("electiveMin"), plan.elective.min > 0 ? plan.elective.min : null)}
        </dl>
        {m.description ? <p className="mt-2 text-muted">{m.description}</p> : null}
      </div>

      <div className="rounded-lg border border-border p-4">
        <h3 className="mb-2 font-medium">{t("progressTitle")}</h3>
        <p>{te("progress", { earned: plan.credits.earned, required: plan.credits.required })}</p>
        <div role="progressbar" aria-label={t("progressTitle")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="my-2 h-2 w-full overflow-hidden rounded bg-border/50"><div className="h-full bg-primary" style={{ width: `${pct}%` }} /></div>
        <ul className="flex flex-wrap gap-x-6 gap-y-1 text-muted">
          {plan.categories.map((c) => <li key={c.category}>{te(`cat_${c.category}`)}: {t("earnedOfPlanned", { earned: c.earned, planned: c.planned })}</li>)}
          {plan.elective.min > 0 ? <li>{t("electiveNeed", { earned: plan.elective.earned, min: plan.elective.min })}</li> : null}
        </ul>
        <p className="mt-2 text-xs text-muted">{te("planNote")} {t("perMajor")}</p>
      </div>

      <DataTable columns={columns} rows={plan.courses} rowKey={(x) => x.courseId} emptyText={tbl.empty} loadingText={tbl.loading} selectable={false} labels={tbl.labels} />
      {info ? <CourseInfoDialog courseId={info} onClose={() => setInfo(null)} /> : null}
    </section>
  );
}
