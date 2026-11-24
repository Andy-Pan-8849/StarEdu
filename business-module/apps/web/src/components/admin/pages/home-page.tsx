"use client";

// 首页：登录后的第一屏，回答"我现在该做什么"。按角色和权限显示不同的块，看不到的功能那块就不出现。
//   - 所有人：欢迎语、最近的消息（含公告）；
//   - 学生：快到期的作业、在读课程、GPA；
//   - 教师/教务：待处理的学生申请、进行中的教学班、学生数。
import { useTranslations } from "next-intl";
import * as React from "react";
import { PERMS } from "@staredu/shared";
import { bff } from "@/lib/bff";
import { useNav } from "../nav-context";
import { usePermissions } from "../permissions";

interface Profile { fullName: string | null; username: string }
interface Note { id: string; title: string; body: string; createdAt: string; readAt: string | null }
interface MyAssignment { id: string; title: string; section: { course: string }; deadline: string; status: string }
interface Overview { totals: { sections: number; inProgressSections: number; students: number } }
interface Grades { cumulative: { gpa: number | null; creditsEarned: number } }

function Card({ title, value, hint, to }: { title: string; value: React.ReactNode; hint?: string; to?: string }) {
  const nav = useNav();
  const body = (
    <>
      <div className="text-xs text-muted">{title}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-muted">{hint}</div> : null}
    </>
  );
  const cls = "rounded-lg border border-border p-4 text-left";
  return to ? <button type="button" className={`${cls} hover:border-primary`} onClick={() => nav.openPage(to)}>{body}</button> : <div className={cls}>{body}</div>;
}

function Block({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border">
      <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h3 className="font-medium">{title}</h3>
        {action}
      </header>
      <div className="p-4 text-sm">{children}</div>
    </section>
  );
}

export function greetingKey(hour: number): "morning" | "afternoon" | "evening" {
  return hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
}

export function HomePage() {
  const t = useTranslations("home");
  const perms = usePermissions();
  const nav = useNav();
  const [profile, setProfile] = React.useState<Profile | null>(null);
  const [notes, setNotes] = React.useState<{ unread: number; items: Note[] } | null>(null);
  const [assignments, setAssignments] = React.useState<MyAssignment[] | null>(null);
  const [enrolled, setEnrolled] = React.useState<number | null>(null);
  const [grades, setGrades] = React.useState<Grades | null>(null);
  const [pending, setPending] = React.useState<number | null>(null);
  const [overview, setOverview] = React.useState<Overview | null>(null);
  const student = perms.has(PERMS.portalAssignmentList);
  const staffRequests = perms.has(PERMS.eduRequestList);
  const dashboard = perms.has(PERMS.eduDashboardView);

  React.useEffect(() => {
    const quiet = () => undefined;
    void bff<Profile>("me/profile").then(setProfile).catch(quiet);
    void bff<{ unread: number; items: Note[] }>("notifications?size=5").then(setNotes).catch(quiet);
    if (student) {
      void bff<MyAssignment[]>("assignments").then(setAssignments).catch(quiet);
      void bff<Array<{ status: string }>>("my-enrollments").then((r) => setEnrolled(r.filter((e) => e.status === "enrolled").length)).catch(quiet);
      if (perms.has(PERMS.portalGradeList)) void bff<Grades>("grades").then(setGrades).catch(quiet);
    }
    if (staffRequests) void bff<Array<unknown>>("requests?status=pending").then((r) => setPending(r.length)).catch(quiet);
    if (dashboard) void bff<Overview>("dashboard/overview").then(setOverview).catch(quiet);
  }, [student, staffRequests, dashboard, perms]);

  const name = profile?.fullName ?? profile?.username ?? "";
  const todo = (assignments ?? []).filter((a) => a.status === "missing").sort((a, b) => a.deadline.localeCompare(b.deadline));
  const due = todo.slice(0, 5);
  const now = Date.now();
  return (
    <div className="space-y-4 text-sm">
      <div>
        <h2 className="text-xl font-semibold">{t(`greeting_${greetingKey(new Date().getHours())}`, { name })}</h2>
        <p className="text-muted">{student ? t("subtitleStudent") : t("subtitleStaff")}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {notes ? <Card title={t("unread")} value={notes.unread} /> : null}
        {student && enrolled !== null ? <Card title={t("myCourses")} value={enrolled} to="portal/enroll/index" /> : null}
        {student && assignments ? <Card title={t("toSubmit")} value={todo.length} to="portal/assignment/index" /> : null}
        {student && grades ? <Card title={t("gpa")} value={grades.cumulative.gpa ?? "–"} hint={t("creditsEarned", { n: grades.cumulative.creditsEarned })} to="portal/grade/index" /> : null}
        {pending !== null ? <Card title={t("pendingRequests")} value={pending} to="edu/request/index" /> : null}
        {overview ? <Card title={t("sectionsInProgress")} value={overview.totals.inProgressSections} hint={t("ofSections", { n: overview.totals.sections })} to="edu/section/index" /> : null}
        {overview ? <Card title={t("students")} value={overview.totals.students} to="edu/dashboard/index" /> : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {student ? (
          <Block title={t("dueSoon")} action={<button type="button" className="text-xs text-primary hover:underline" onClick={() => nav.openPage("portal/assignment/index")}>{t("viewAll")}</button>}>
            {assignments === null ? <p className="text-muted">…</p> : due.length === 0 ? <p className="text-muted">{t("nothingDue")}</p> : (
              <ul className="space-y-2">
                {due.map((a) => (
                  <li key={a.id} className="flex items-baseline justify-between gap-3">
                    <span><span className="font-medium">{a.title}</span> <span className="text-muted">· {a.section.course}</span></span>
                    <span className={new Date(a.deadline).getTime() < now ? "text-red-600" : "text-muted"}>{new Date(a.deadline).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </Block>
        ) : null}
        <Block title={t("recentMessages")}>
          {notes === null ? <p className="text-muted">…</p> : notes.items.length === 0 ? <p className="text-muted">{t("noMessages")}</p> : (
            <ul className="space-y-2">
              {notes.items.map((n) => (
                <li key={n.id}>
                  <div className={n.readAt ? "" : "font-medium"}>{n.title}</div>
                  <div className="line-clamp-2 text-muted">{n.body}</div>
                  <div className="text-xs text-muted">{new Date(n.createdAt).toLocaleString()}</div>
                </li>
              ))}
            </ul>
          )}
        </Block>
      </div>
    </div>
  );
}
