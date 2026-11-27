"use client";

// 学生门户：课程详情（选课前要看清这门课，选上之后也能回头看）和"我的课程"页。
import { StudentAssignments } from "./assignment-pages";
import { StudentMaterials } from "./material-pages";
import { TabBody, Tabs } from "../tabs";
import { useTranslations } from "next-intl";
import * as React from "react";
import { UserMinus } from "lucide-react";
import { PERMS } from "@staredu/shared";
import { Button } from "@/components/ui/button";
import { bff } from "@/lib/bff";
import { Modal } from "../modal";
import { DataTable, type Column } from "../data-table";
import { PermRowAction } from "../icon-button";
import { PermButton } from "../permissions";
import { useTable } from "./use-table";

export interface SectionDetail {
  id: string;
  name: string;
  course: { code: string; name: string; credits: number; syllabus: string | null };
  term: { name: string; startDate: string; endDate: string };
  campus: string;
  mode: string;
  schedule: Array<{ weekday: number; start: string; end: string; room?: string }>;
  notes: string | null;
  capacity: number;
  seatsLeft: number;
  instructors: Array<{ role: string; fullName: string | null }>;
  prerequisites: Array<{ code: string; name: string; met: boolean }>;
  requirement: string | null;
  myEnrollment: { id: string; status: string } | null;
}

/** 课程名：点一下打开详情（像链接，不是按钮的样子）。 */
export function CourseLink({ children, onOpen }: { children: React.ReactNode; onOpen: () => void }) {
  return <button type="button" className="text-left font-medium text-primary hover:underline" onClick={onOpen}>{children}</button>;
}

export function CourseDetailDialog({ sectionId, onClose, onEnroll }: { sectionId: string; onClose: () => void; onEnroll?: (sectionId: string) => void }) {
  const t = useTranslations("pages.courseDetail");
  const c = useTranslations("crud");
  const edu = useTranslations("pages.edu");
  const [tab, setTab] = React.useState<"basic" | "instructors" | "materials" | "assignments">("basic");
  const [d, setD] = React.useState<SectionDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => { void bff<SectionDetail>(`sections/${sectionId}`).then(setD).catch((e: Error) => setError(e.message)); }, [sectionId]);
  const row = (label: string, value: React.ReactNode) => (value ? <div className="grid grid-cols-[8rem_1fr] gap-2"><dt className="text-muted">{label}</dt><dd>{value}</dd></div> : null);
  return (
    <Modal title={d ? `${d.course.code} · ${d.course.name}` : t("title")} onClose={onClose}>
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : !d ? <p className="text-sm text-muted">…</p> : (
        <div className="space-y-3 text-sm">
          {/* 选上这个班以后才有课件和作业两个页签 */}
          <Tabs value={tab} onChange={setTab} items={(["basic", "instructors", ...(d.myEnrollment ? ["materials", "assignments"] : [])] as Array<typeof tab>).map((k) => ({ key: k, label: t(`tab_${k}`) }))} />
          <TabBody>
            {tab === "basic" ? (
              <div className="space-y-3">
                <dl className="space-y-1.5">
                  {row(t("credits"), d.course.credits)}
                  {row(t("section"), d.name)}
                  {row(t("term"), `${d.term.name} (${d.term.startDate} – ${d.term.endDate})`)}
                  {row(t("campus"), d.campus)}
                  {row(t("mode"), t(`mode_${d.mode}`))}
                  {row(t("schedule"), d.schedule.length === 0 ? t("noSchedule") : (
                    <ul>{d.schedule.map((s, i) => <li key={i}>{t(`weekday_${s.weekday}`)} {s.start}–{s.end}{s.room ? ` · ${s.room}` : ""}</li>)}</ul>
                  ))}
                  {row(t("seats"), t("seatsOf", { left: d.seatsLeft, capacity: d.capacity }))}
                  {row(t("prerequisites"), d.prerequisites.length === 0 ? t("none") : (
                    <ul>{d.prerequisites.map((p) => <li key={p.code}>{p.code} · {p.name} <span className={p.met ? "text-green-700" : "text-red-600"}>({p.met ? t("passed") : t("notPassed")})</span></li>)}</ul>
                  ))}
                  {row(t("notes"), d.notes)}
                </dl>
                <div>
                  <h3 className="mb-1 font-medium">{t("syllabus")}</h3>
                  <p className="whitespace-pre-wrap text-muted">{d.course.syllabus?.trim() ? d.course.syllabus : t("noSyllabus")}</p>
                </div>
              </div>
            ) : null}
            {tab === "instructors" ? (
              d.instructors.length === 0 ? <p className="text-muted">{t("noInstructors")}</p> : (
                <ul className="list-disc pl-5">{d.instructors.map((i, n) => <li key={n}>{i.fullName} ({edu(`role_${i.role}`)})</li>)}</ul>
              )
            ) : null}
            {tab === "materials" ? <StudentMaterials sectionId={d.id} /> : null}
            {tab === "assignments" ? <StudentAssignments sectionId={d.id} /> : null}
          </TabBody>
          <div className="flex gap-2 border-t border-border pt-3">
            {onEnroll && !d.myEnrollment ? (
              <PermButton perm={PERMS.portalEnrollAdd} size="sm" disabled={d.seatsLeft === 0} onClick={() => onEnroll(d.id)}>{d.seatsLeft === 0 ? t("full") : t("enroll")}</PermButton>
            ) : null}
            <Button size="sm" variant="outline" onClick={onClose}>{c("close")}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

interface MyEnrollment { id: string; status: string; course: { code: string; name: string }; term: string; canDrop: boolean; willBeW: boolean; section: { id: string; name: string } }

// ---------------------------------------------------------------- 学生门户：我的课程
export function PortalCoursesPage() {
  const t = useTranslations("pages.edu");
  const c = useTranslations("crud");
  const tbl = useTable();
  const [rows, setRows] = React.useState<MyEnrollment[] | null>(null);
  const [detail, setDetail] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ text: string; error: boolean } | null>(null);
  const load = React.useCallback(() => { void bff<MyEnrollment[]>("my-enrollments").then(setRows); }, []);
  React.useEffect(load, [load]);
  const drop = async (e: MyEnrollment) => {
    if (!window.confirm(e.willBeW ? t("confirmDropW") : t("confirmDrop"))) return;
    try { await bff(`enrollments/${e.id}`, { method: "DELETE" }); setMsg({ text: c("done"), error: false }); } catch (err) { setMsg({ text: (err as Error).message, error: true }); }
    load();
  };
  const cols: Column<MyEnrollment>[] = [
    { key: "course", header: t("name"), cell: (e) => <CourseLink onOpen={() => setDetail(e.section.id)}>{e.course.code} · {e.course.name}</CourseLink> },
    { key: "section", header: t("sectionCol"), cell: (e) => e.section.name },
    { key: "term", header: t("term"), cell: (e) => e.term },
    { key: "status", header: t("state"), cell: (e) => t(`enr_${e.status}`) },
    { key: "actions", header: "", cell: (e) => (e.canDrop ? <PermRowAction perm={PERMS.portalEnrollDrop} onClick={() => void drop(e)} icon={UserMinus} danger>{t("drop")}</PermRowAction> : null) },
  ];
  return (
    <section className="text-sm">
      <h2 className="mb-3 text-lg font-semibold">{t("myCourses")}</h2>
      {msg ? <p role={msg.error ? "alert" : "status"} className={`mb-2 ${msg.error ? "text-red-600" : "text-muted"}`}>{msg.text}</p> : null}
      <DataTable columns={cols} rows={rows ?? []} rowKey={(e) => e.id} loading={rows === null} emptyText={tbl.empty} loadingText={tbl.loading} selectable={false} labels={tbl.labels} />
      {detail ? <CourseDetailDialog sectionId={detail} onClose={() => setDetail(null)} /> : null}
    </section>
  );
}
