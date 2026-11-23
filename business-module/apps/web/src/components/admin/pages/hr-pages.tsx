"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { PERMS } from "@staredu/shared";
import { Button } from "@/components/ui/button";
import { bff } from "@/lib/bff";
import { DataTable, type Column } from "../data-table";
import { Modal } from "../modal";
import { Can, PermButton, usePermissions } from "../permissions";
import { FormPanel, useAct, type Field } from "./crud";
import { useList } from "./use-api";

const H2 = ({ children }: { children: React.ReactNode }) => <h2 className="mb-3 text-lg font-semibold">{children}</h2>;
const Err = ({ error }: { error: string | null }) => (error ? <p role="alert" className="mb-2 text-sm text-red-600">{error}</p> : null);
function useTable() {
  const t = useTranslations("table");
  return { empty: t("empty"), loading: t("loading"), labels: { previous: t("previous"), next: t("next"), page: (p: number, n: number) => t("page", { page: p, pages: n }) } };
}

/** 导入面板：选一个 CSV 文件，先"只检查"，再"导入"；显示新增/更新/未变和出错的行。 */
function ImportPanel({ path, onDone, columns }: { path: string; onDone: () => void; columns: string }) {
  const t = useTranslations("pages.hr");
  const [csv, setCsv] = React.useState<string | null>(null);
  const [aliases, setAliases] = React.useState("");
  const [result, setResult] = React.useState<{ created: number; updated: number; unchanged: number; errorCount: number; errors: Array<{ row: number; message: string }>; dryRun: boolean } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  async function send(dryRun: boolean) {
    setError(null);
    let campusAliases: Record<string, string> | undefined;
    if (aliases.trim()) {
      campusAliases = Object.fromEntries(aliases.split(",").map((p) => p.split("=").map((x) => x.trim())).filter((p) => p.length === 2 && p[0] && p[1]));
    }
    try {
      const r = await bff<NonNullable<typeof result>>(path, { method: "POST", body: { csv, dryRun, campusAliases } });
      setResult(r);
      if (!dryRun) onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="mb-3 rounded-md border border-border p-3 text-sm">
      <p className="mb-2 text-muted">{t("importHint", { columns })}</p>
      <input type="file" accept=".csv,text/csv" aria-label={t("chooseFile")} onChange={async (e) => { const f = e.target.files?.[0]; setCsv(f ? await f.text() : null); setResult(null); }} />
      <label className="my-2 flex flex-col gap-1">{t("aliases")}<input className="rounded-md border border-border bg-transparent px-2 py-1" placeholder="BJ=HQ" value={aliases} onChange={(e) => setAliases(e.target.value)} /></label>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={!csv} onClick={() => void send(true)}>{t("check")}</Button>
        <Button size="sm" disabled={!csv} onClick={() => void send(false)}>{t("import")}</Button>
      </div>
      <Err error={error} />
      {result ? (
        <div role="status" className="mt-2">
          <p>{result.dryRun ? t("checked") : t("imported")}: {t("counts", { created: result.created, updated: result.updated, unchanged: result.unchanged, errors: result.errorCount })}</p>
          {result.errors.length ? <ul className="mt-1 list-disc pl-5 text-red-600">{result.errors.map((x) => <li key={x.row}>{t("row", { row: x.row })}: {x.message}</li>)}</ul> : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- 人员目录（所有自然人：教职员工和学生）
interface PersonRow { id: string; type: string; fullName: string; workEmail: string | null }
interface PersonDetail extends PersonRow { sensitive?: { birthDate: string | null; gender: string | null; idNumber: string | null; phone: string | null; address: string | null } }

export function PeoplePage() {
  const t = useTranslations("pages.hr");
  const tt = useTable();
  const perms = usePermissions();
  const list = useList<PersonRow>("persons");
  const [q, setQ] = React.useState("");
  const [type, setType] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [open, setOpen] = React.useState<string | null>(null);
  const filtered = list.rows.filter((r) => (!type || r.type === type) && (!q || `${r.fullName} ${r.workEmail ?? ""}`.toLowerCase().includes(q.toLowerCase())));
  const shown = filtered.slice((page - 1) * 20, page * 20);
  const columns: Column<PersonRow>[] = [
    { key: "name", header: t("name"), cell: (r) => r.fullName },
    { key: "type", header: t("personType"), cell: (r) => t(`person_${r.type}`) },
    { key: "email", header: t("email"), cell: (r) => r.workEmail ?? "" },
    { key: "actions", header: "", cell: (r) => <Button size="sm" variant="outline" onClick={() => setOpen(r.id)}>{t("details")}</Button> },
  ];
  return (
    <section>
      <H2>{t("peopleTitle")}</H2>
      <p className="mb-3 text-sm text-muted">{t("peopleHint")}</p>
      <Err error={list.error} />
      <div className="mb-3 flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col gap-1">{t("search")}<input className="rounded-md border border-border bg-transparent px-2 py-1" value={q} onChange={(e) => { setPage(1); setQ(e.target.value); }} /></label>
        <label className="flex flex-col gap-1">{t("personType")}
          <select className="rounded-md border border-border bg-transparent px-2 py-1" value={type} onChange={(e) => { setPage(1); setType(e.target.value); }}>
            <option value="">{t("allTypes")}</option><option value="staff">{t("person_staff")}</option><option value="student">{t("person_student")}</option>
          </select>
        </label>
      </div>
      <DataTable columns={columns} rows={shown} rowKey={(r) => r.id} loading={list.loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} pagination={{ page, size: 20, hasMore: filtered.length > page * 20, onPageChange: setPage }} />
      {open ? <PersonDetailPanel id={open} canEmergency={perms.has(PERMS.hrEmergencyView)} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}

function PersonDetailPanel({ id, canEmergency, onClose }: { id: string; canEmergency: boolean; onClose: () => void }) {
  const t = useTranslations("pages.hr");
  const c = useTranslations("crud");
  const [d, setD] = React.useState<PersonDetail | null>(null);
  React.useEffect(() => { void bff<PersonDetail>(`persons/${id}`).then(setD); }, [id]);
  if (!d) return <Modal title={t("details")} onClose={onClose}><p className="text-sm text-muted">…</p></Modal>;
  return (
    <Modal title={d.fullName} onClose={onClose}>
    <div className="text-sm">
      <h3 className="mb-2 font-medium">{d.fullName} <span className="text-muted">({t(`person_${d.type}`)})</span></h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted">{t("email")}</dt><dd>{d.workEmail ?? ""}</dd>
        {d.sensitive ? (
          <>
            <dt className="text-muted">{t("birthDate")}</dt><dd>{d.sensitive.birthDate ?? ""}</dd>
            <dt className="text-muted">{t("gender")}</dt><dd>{d.sensitive.gender ?? ""}</dd>
            <dt className="text-muted">{t("idNumber")}</dt><dd>{d.sensitive.idNumber ?? ""}</dd>
            <dt className="text-muted">{t("phone")}</dt><dd>{d.sensitive.phone ?? ""}</dd>
            <dt className="text-muted">{t("address")}</dt><dd>{d.sensitive.address ?? ""}</dd>
          </>
        ) : null}
      </dl>
      {!d.sensitive ? <p className="mt-2 text-muted">{t("noSensitive")}</p> : null}
      {canEmergency ? <div className="mt-3"><h4 className="mb-1 font-medium">{t("tab_emergency")}</h4><EmergencyTab personId={id} /></div> : null}
      <Button size="sm" variant="outline" className="mt-3" onClick={onClose}>{c("close")}</Button>
    </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- 教职员工
interface Assignment { id: string; deptId: string; deptName: string | null; postName: string | null; isPrimary: boolean; startDate: string; endDate: string | null; current: boolean }
interface StaffRow { id: string; fullName: string; workEmail: string | null; employeeNo: string | null; status: string | null; hireDate: string | null; campuses: string[] }
interface StaffDetail { id: string; fullName: string; workEmail: string | null; staff: { employeeNo: string; hireDate: string; status: string; pendingStatus: string | null; pendingEffectiveOn: string | null } | null; assignments: Assignment[]; campuses: Array<{ name: string }>; sensitive?: { birthDate: string | null; gender: string | null; idNumber: string | null; phone: string | null; address: string | null } }
interface Contact { id: string; priority: number; name: string; relationship: string; phone: string; isGuardian: boolean }
interface NamedRow { id: string; name: string; status?: boolean }

export function StaffPage() {
  const t = useTranslations("pages.hr");
  const c = useTranslations("crud");
  const tt = useTable();
  const perms = usePermissions();
  const [q, setQ] = React.useState("");
  const [page, setPage] = React.useState(1);
  const list = useList<StaffRow>(`staff?page=${page}&size=20${q ? `&q=${encodeURIComponent(q)}` : ""}`);
  const depts = useList<NamedRow>("depts");
  const { run, message } = useAct(list.reload);
  const [form, setForm] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [open, setOpen] = React.useState<string | null>(null);
  const fields: Field[] = [
    { name: "fullName", label: t("name"), required: true },
    { name: "workEmail", label: t("email"), type: "email" },
    { name: "hireDate", label: t("hireDate"), required: true },
    { name: "employmentType", label: t("employmentType"), type: "select", options: [{ value: "full_time", label: t("full_time") }, { value: "part_time", label: t("part_time") }] },
    { name: "deptId", label: t("department"), type: "select", options: depts.rows.filter((d) => d.status !== false).map((d) => ({ value: d.id, label: d.name })) },
  ];
  const columns: Column<StaffRow>[] = [
    { key: "no", header: t("employeeNo"), cell: (r) => r.employeeNo ?? "" },
    { key: "name", header: t("name"), cell: (r) => r.fullName },
    { key: "campus", header: t("campus"), cell: (r) => r.campuses.join(", ") },
    { key: "status", header: c("status"), cell: (r) => (r.status ? t(`staff_${r.status}`) : "") },
    { key: "actions", header: "", cell: (r) => <Button size="sm" variant="outline" onClick={() => setOpen(r.id)}>{t("details")}</Button> },
  ];
  return (
    <section>
      <H2>{t("staffTitle")}</H2>
      <Err error={list.error} />
      {message}
      <div className="mb-3 flex flex-wrap items-end gap-2 text-sm">
        <Can perm={PERMS.hrStaffAdd}>{!form ? <Button size="sm" onClick={() => setForm(true)}>{c("add")}</Button> : null}</Can>
        <Can perm={PERMS.hrStaffImport}><Button size="sm" variant="outline" onClick={() => setImporting(!importing)}>{t("importCsv")}</Button></Can>
        <a className="text-sm underline" href="/bff/staff/export">{t("exportCsv")}</a>
        <label className="flex flex-col gap-1">{t("search")}<input className="rounded-md border border-border bg-transparent px-2 py-1" value={q} onChange={(e) => { setPage(1); setQ(e.target.value); }} /></label>
      </div>
      {importing ? <ImportPanel path="import/staff" columns="employee_id, name, campus_id, department, title, hire_date, status" onDone={list.reload} /> : null}
      {form ? (
        <FormPanel title={c("add")} fields={fields} submitLabel={c("save")} cancelLabel={c("cancel")} onCancel={() => setForm(false)}
          onSubmit={async (p) => { const { deptId, ...rest } = p; if (await run(() => bff("staff", { method: "POST", body: { ...rest, assignments: deptId ? [{ deptId }] : undefined } }), c("saved"))) setForm(false); }} />
      ) : null}
      <DataTable columns={columns} rows={list.rows} rowKey={(r) => r.id} loading={list.loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} pagination={{ page, size: 20, hasMore: list.rows.length === 20, onPageChange: setPage }} />
      {open ? <StaffDetailPanel id={open} depts={depts.rows} canEmergency={perms.has(PERMS.hrEmergencyView)} onClose={() => { setOpen(null); list.reload(); }} /> : null}
    </section>
  );
}

function StaffDetailPanel({ id, depts, canEmergency, onClose }: { id: string; depts: NamedRow[]; canEmergency: boolean; onClose: () => void }) {
  const t = useTranslations("pages.hr");
  const c = useTranslations("crud");
  const [tab, setTab] = React.useState<"basic" | "assign" | "emergency">("basic");
  const detail = useList<StaffDetail>(`staff/${id}`); // 返回对象，下面取第一个字段
  const [d, setD] = React.useState<StaffDetail | null>(null);
  const reload = React.useCallback(() => { void bff<StaffDetail>(`staff/${id}`).then(setD); }, [id]);
  React.useEffect(reload, [reload]);
  void detail;
  const { run, message } = useAct(reload);
  const [transfer, setTransfer] = React.useState<Assignment | null>(null);
  if (!d) return <Modal title={t("details")} onClose={onClose}><p className="text-sm text-muted">…</p></Modal>;
  const deptOptions = depts.filter((x) => x.status !== false).map((x) => ({ value: x.id, label: x.name }));
  return (
    <Modal title={d.fullName} onClose={onClose}>
    <div className="text-sm">
      <h3 className="mb-2 font-medium">{d.fullName} {d.staff ? `(${d.staff.employeeNo})` : ""}</h3>
      <div role="tablist" className="mb-3 flex gap-2">
        {(["basic", "assign", ...(canEmergency ? (["emergency"] as const) : [])] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "font-medium underline" : "text-muted"} onClick={() => setTab(k)}>{t(`tab_${k}`)}</button>
        ))}
      </div>
      {message}
      {tab === "basic" ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted">{t("email")}</dt><dd>{d.workEmail ?? ""}</dd>
          <dt className="text-muted">{t("hireDate")}</dt><dd>{d.staff?.hireDate}</dd>
          <dt className="text-muted">{c("status")}</dt><dd>{d.staff ? t(`staff_${d.staff.status}`) : ""}{d.staff?.pendingStatus ? ` → ${t(`staff_${d.staff.pendingStatus}`)} (${d.staff.pendingEffectiveOn})` : ""}</dd>
          <dt className="text-muted">{t("campus")}</dt><dd>{d.campuses.map((x) => x.name).join(", ")}</dd>
          {d.sensitive ? (<><dt className="text-muted">{t("idNumber")}</dt><dd>{d.sensitive.idNumber}</dd><dt className="text-muted">{t("phone")}</dt><dd>{d.sensitive.phone}</dd></>) : null}
        </dl>
      ) : null}
      {tab === "basic" && d.staff ? (
        <div className="mt-3 flex gap-2">
          {d.staff.status === "active" ? (
            <PermButton perm={PERMS.hrStaffEnd} size="sm" variant="outline" onClick={() => { const date = window.prompt(t("endPrompt"), new Date().toISOString().slice(0, 10)); if (date) void run(() => bff(`staff/${id}/end`, { method: "POST", body: { status: "left", effectiveDate: date } }), c("done")); }}>{t("endEmployment")}</PermButton>
          ) : (
            <PermButton perm={PERMS.hrStaffEnd} size="sm" variant="outline" onClick={() => void run(() => bff(`staff/${id}/reinstate`, { method: "POST" }), c("done"))}>{t("reinstate")}</PermButton>
          )}
        </div>
      ) : null}
      {tab === "assign" ? (
        <div>
          <ul className="mb-3 list-disc pl-5">
            {d.assignments.map((a) => (
              <li key={a.id} className={a.current ? "" : "text-muted"}>
                {a.deptName}{a.postName ? ` · ${a.postName}` : ""}{a.isPrimary ? ` (${t("primary")})` : ""} — {a.startDate} → {a.endDate ?? t("present")}
                {a.current ? <PermButton perm={PERMS.hrStaffAssign} size="sm" variant="outline" className="ml-2" onClick={() => setTransfer(a)}>{t("transfer")}</PermButton> : null}
                {a.current ? <PermButton perm={PERMS.hrStaffAssign} size="sm" variant="outline" className="ml-1" onClick={() => void run(() => bff(`staff/${id}/assignments/${a.id}`, { method: "DELETE" }), c("done"))}>{t("endAssignment")}</PermButton> : null}
              </li>
            ))}
          </ul>
          {transfer ? (
            <FormPanel title={t("transfer")} fields={[{ name: "deptId", label: t("department"), type: "select", required: true, options: deptOptions }, { name: "effectiveDate", label: t("effectiveDate") }]} submitLabel={c("save")} cancelLabel={c("cancel")} onCancel={() => setTransfer(null)}
              onSubmit={async (p) => { if (await run(() => bff(`staff/${id}/transfer`, { method: "POST", body: { fromAssignmentId: transfer.id, ...p } }), c("saved"))) setTransfer(null); }} />
          ) : (
            <Can perm={PERMS.hrStaffAssign}>
              <FormPanel title={t("addAssignment")} fields={[{ name: "deptId", label: t("department"), type: "select", required: true, options: deptOptions }, { name: "isPrimary", label: t("primary"), type: "checkbox" }]} submitLabel={c("add")} cancelLabel={c("cancel")} onCancel={() => undefined}
                onSubmit={async (p) => { await run(() => bff(`staff/${id}/assignments`, { method: "POST", body: p }), c("saved")); }} />
            </Can>
          )}
        </div>
      ) : null}
      {tab === "emergency" ? <EmergencyTab personId={id} /> : null}
      <Button size="sm" variant="outline" className="mt-3" onClick={onClose}>{c("close")}</Button>
    </div>
    </Modal>
  );
}

function EmergencyTab({ personId }: { personId: string }) {
  const t = useTranslations("pages.hr");
  const c = useTranslations("crud");
  const list = useList<Contact>(`persons/${personId}/emergency-contacts`);
  const { run, message } = useAct(list.reload);
  const [form, setForm] = React.useState(false);
  const tt = useTable();
  const columns: Column<Contact>[] = [
    { key: "p", header: "#", cell: (r) => r.priority },
    { key: "name", header: t("name"), cell: (r) => r.name },
    { key: "rel", header: t("relationship"), cell: (r) => r.relationship },
    { key: "phone", header: t("phone"), cell: (r) => r.phone },
    { key: "g", header: t("guardian"), cell: (r) => (r.isGuardian ? c("enabled") : "") },
    { key: "a", header: "", cell: (r) => <PermButton perm={PERMS.hrEmergencyEdit} size="sm" variant="outline" onClick={() => window.confirm(c("confirmDelete", { name: r.name })) && void run(() => bff(`persons/${personId}/emergency-contacts/${r.id}`, { method: "DELETE" }), c("done"))}>{c("delete")}</PermButton> },
  ];
  return (
    <div>
      <p className="mb-2 text-muted">{t("emergencyNote")}</p>
      <Err error={list.error} />
      {message}
      <Can perm={PERMS.hrEmergencyEdit}>{!form ? <Button size="sm" className="mb-2" onClick={() => setForm(true)}>{c("add")}</Button> : null}</Can>
      {form ? (
        <FormPanel title={c("add")} fields={[{ name: "name", label: t("name"), required: true }, { name: "relationship", label: t("relationship"), required: true }, { name: "phone", label: t("phone"), required: true }, { name: "isGuardian", label: t("guardian"), type: "checkbox" }]} submitLabel={c("save")} cancelLabel={c("cancel")} onCancel={() => setForm(false)}
          onSubmit={async (p) => { if (await run(() => bff(`persons/${personId}/emergency-contacts`, { method: "POST", body: p }), c("saved"))) setForm(false); }} />
      ) : null}
      <DataTable columns={columns} rows={list.rows} rowKey={(r) => r.id} loading={list.loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
    </div>
  );
}

// ---------------------------------------------------------------- 学生
interface StudentRow { id: string; fullName: string; studentNo: string | null; campusId: string | null; campusName: string | null; academicStatus: string | null; enrollTerm: string | null; program: string | null }
interface CampusRow { id: string; name: string; code: string; status: string }

export function StudentsPage() {
  const t = useTranslations("pages.hr");
  const c = useTranslations("crud");
  const tt = useTable();
  const [q, setQ] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [page, setPage] = React.useState(1);
  const list = useList<StudentRow>(`students?page=${page}&size=20${q ? `&q=${encodeURIComponent(q)}` : ""}${status ? `&status=${status}` : ""}`);
  const campuses = useList<CampusRow>("campuses");
  const { run, message } = useAct(list.reload);
  const [form, setForm] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [editing, setEditing] = React.useState<StudentRow | null>(null);
  const statuses = ["enrolled", "on_leave", "graduated", "withdrawn", "completed"];
  const fields: Field[] = [
    { name: "fullName", label: t("name"), required: true },
    { name: "workEmail", label: t("email"), type: "email" },
    { name: "campusId", label: t("campus"), type: "select", required: true, options: campuses.rows.filter((x) => x.status === "normal").map((x) => ({ value: x.id, label: x.name })) },
    { name: "enrollTerm", label: t("enrollTerm") },
    { name: "program", label: t("program") },
  ];
  const columns: Column<StudentRow>[] = [
    { key: "no", header: t("studentNo"), cell: (r) => r.studentNo ?? "" },
    { key: "name", header: t("name"), cell: (r) => r.fullName },
    { key: "campus", header: t("campus"), cell: (r) => r.campusName ?? "" },
    { key: "program", header: t("program"), cell: (r) => r.program ?? "" },
    { key: "term", header: t("enrollTerm"), cell: (r) => r.enrollTerm ?? "" },
    { key: "status", header: c("status"), cell: (r) => (r.academicStatus ? t(`student_${r.academicStatus}`) : "") },
    {
      key: "actions",
      header: "",
      cell: (r) => (
        <PermButton perm={PERMS.hrStudentEdit} size="sm" variant="outline" onClick={() => setEditing(r)}>{t("changeStatus")}</PermButton>
      ),
    },
  ];
  return (
    <section>
      <H2>{t("studentsTitle")}</H2>
      <Err error={list.error} />
      {message}
      <div className="mb-3 flex flex-wrap items-end gap-2 text-sm">
        <Can perm={PERMS.hrStudentAdd}>{!form ? <Button size="sm" onClick={() => setForm(true)}>{c("add")}</Button> : null}</Can>
        <Can perm={PERMS.hrStudentImport}><Button size="sm" variant="outline" onClick={() => setImporting(!importing)}>{t("importCsv")}</Button></Can>
        <a className="text-sm underline" href="/bff/students/export">{t("exportCsv")}</a>
        <label className="flex flex-col gap-1">{t("search")}<input className="rounded-md border border-border bg-transparent px-2 py-1" value={q} onChange={(e) => { setPage(1); setQ(e.target.value); }} /></label>
        <label className="flex flex-col gap-1">{c("status")}
          <select className="rounded-md border border-border bg-transparent px-2 py-1" value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
            <option value="" />{statuses.map((s) => <option key={s} value={s}>{t(`student_${s}`)}</option>)}
          </select>
        </label>
      </div>
      {editing ? (
        <Modal title={t("changeStatus")} onClose={() => setEditing(null)}>
          <p className="mb-2 text-sm">{editing.fullName}{editing.studentNo ? ` (${editing.studentNo})` : ""}</p>
          <FormPanel title={t("changeStatus")} fields={[{ name: "academicStatus", label: c("status"), type: "select", required: true, options: statuses.map((s) => ({ value: s, label: t(`student_${s}`) })) }]} initial={{ academicStatus: editing.academicStatus ?? "" }} submitLabel={c("save")} cancelLabel={c("cancel")} onCancel={() => setEditing(null)}
            onSubmit={async (p) => { if (await run(() => bff(`students/${editing.id}`, { method: "PATCH", body: { academicStatus: p.academicStatus } }), c("saved"))) setEditing(null); }} />
        </Modal>
      ) : null}
      {importing ? <ImportPanel path="import/students" columns="student_id, name, campus_id, program, cohort, status" onDone={list.reload} /> : null}
      {form ? <FormPanel title={c("add")} fields={fields} submitLabel={c("save")} cancelLabel={c("cancel")} onCancel={() => setForm(false)} onSubmit={async (p) => { if (await run(() => bff("students", { method: "POST", body: p }), c("saved"))) setForm(false); }} /> : null}
      <DataTable columns={columns} rows={list.rows} rowKey={(r) => r.id} loading={list.loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} pagination={{ page, size: 20, hasMore: list.rows.length === 20, onPageChange: setPage }} />
    </section>
  );
}
