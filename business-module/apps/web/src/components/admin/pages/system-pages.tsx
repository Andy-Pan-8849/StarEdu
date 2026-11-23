"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { PERMS } from "@staredu/shared";
import { Button } from "@/components/ui/button";
import { bff } from "@/lib/bff";
import { Modal } from "../modal";
import { usePromptDialog } from "../prompt-dialog";
import { DataTable, type Column } from "../data-table";
import { Can, PermButton } from "../permissions";
import { FormPanel, useAct, type Field } from "./crud";
import { useList } from "./use-api";

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "");
const H2 = ({ children }: { children: React.ReactNode }) => <h2 className="mb-3 text-lg font-semibold">{children}</h2>;

function useTable() {
  const t = useTranslations("table");
  return { empty: t("empty"), loading: t("loading"), labels: { actions: t("actions"), selectAll: t("selectAll"), selectRow: t("selectRow"), clearSelection: t("clearSelection"), selected: (n: number) => t("selected", { n }), previous: t("previous"), next: t("next"), page: (p: number, n: number) => t("page", { page: p, pages: n }) } };
}

// ---------------------------------------------------------------- 岗位
interface PostRow { id: string; code: string; name: string; sort: number; status: boolean }

export function PostsPage() {
  const t = useTranslations("pages.posts");
  const c = useTranslations("crud");
  const tt = useTable();
  const { rows, loading, error, reload } = useList<PostRow>("posts");
  const { run, message } = useAct(reload);
  const [form, setForm] = React.useState<{ row?: PostRow } | null>(null);
  const fields: Field[] = [
    { name: "code", label: t("code"), required: true, readOnly: !!form?.row },
    { name: "name", label: t("name"), required: true },
    { name: "sort", label: c("sort"), type: "number" },
    ...(form?.row ? [{ name: "status", label: c("enabled"), type: "checkbox" as const }] : []),
  ];
  const columns: Column<PostRow>[] = [
    { key: "code", header: t("code"), cell: (r) => r.code },
    { key: "name", header: t("name"), cell: (r) => r.name },
    { key: "sort", header: c("sort"), cell: (r) => r.sort },
    { key: "status", header: c("status"), cell: (r) => (r.status ? c("enabled") : c("disabled")) },
    {
      key: "actions",
      header: "",
      cell: (r) => (
        <div className="flex gap-1">
          <PermButton perm={PERMS.postEdit} size="sm" variant="outline" onClick={() => setForm({ row: r })}>{c("edit")}</PermButton>
          <PermButton perm={PERMS.postRemove} size="sm" variant="outline" onClick={() => window.confirm(c("confirmDelete", { name: r.name })) && void run(() => bff(`posts/${r.id}`, { method: "DELETE" }), c("done"))}>{c("delete")}</PermButton>
        </div>
      ),
    },
  ];
  return (
    <section>
      <H2>{t("title")}</H2>
      {error ? <p role="alert" className="mb-2 text-sm text-red-600">{error}</p> : null}
      {message}
      <Can perm={PERMS.postAdd}>{!form ? <Button size="sm" className="mb-3" onClick={() => setForm({})}>{c("add")}</Button> : null}</Can>
      {form ? (
        <FormPanel
          title={form.row ? c("edit") : c("add")}
          fields={fields}
          initial={form.row ? { code: form.row.code, name: form.row.name, sort: String(form.row.sort), status: form.row.status } : {}}
          submitLabel={c("save")}
          cancelLabel={c("cancel")}
          onCancel={() => setForm(null)}
          onSubmit={async (p) => { if (await run(() => (form.row ? bff(`posts/${form.row.id}`, { method: "PATCH", body: p }) : bff("posts", { method: "POST", body: p })), c("saved"))) setForm(null); }}
        />
      ) : null}
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
    </section>
  );
}

// ---------------------------------------------------------------- 校区
interface CampusRow { id: string; code: string; name: string; shortName: string | null; address: string | null; timezone: string; type: "hq" | "campus"; status: "normal" | "stop_new" | "closed" }
interface Closure { students: { count: number }; staffAssignments: { count: number }; classes: { count: number; implemented: boolean } }

export function CampusesPage() {
  const t = useTranslations("pages.campuses");
  const c = useTranslations("crud");
  const tt = useTable();
  const { rows, loading, error, reload } = useList<CampusRow>("campuses");
  const { run, message, setMessage } = useAct(reload);
  const [form, setForm] = React.useState<{ row?: CampusRow } | null>(null);
  const [closure, setClosure] = React.useState<{ campus: CampusRow; data: Closure } | null>(null);
  const fields: Field[] = [
    { name: "code", label: t("code"), required: true, readOnly: !!form?.row },
    { name: "name", label: t("name"), required: true },
    { name: "shortName", label: t("shortName") },
    { name: "address", label: t("address") },
    { name: "timezone", label: t("timezone") },
  ];
  const { ask, dialog } = usePromptDialog();
  const setStatus = (r: CampusRow, status: string, confirmName?: string) => run(() => bff(`campuses/${r.id}/status`, { method: "POST", body: { status, confirmName } }), c("done"));
  async function startClose(r: CampusRow) {
    const data = await bff<Closure>(`campuses/${r.id}/closure-check`);
    setClosure({ campus: r, data });
  }
  const columns: Column<CampusRow>[] = [
    { key: "code", header: t("code"), cell: (r) => r.code },
    { key: "name", header: t("name"), cell: (r) => `${r.name}${r.type === "hq" ? ` (${t("hq")})` : ""}${r.status === "closed" ? ` ${t("closedSuffix")}` : ""}` },
    { key: "timezone", header: t("timezone"), cell: (r) => r.timezone },
    { key: "status", header: c("status"), cell: (r) => t(`status_${r.status}`) },
    {
      key: "actions",
      header: "",
      cell: (r) => (
        <div className="flex flex-wrap gap-1">
          <PermButton perm={PERMS.campusEdit} size="sm" variant="outline" onClick={() => setForm({ row: r })}>{c("edit")}</PermButton>
          {r.type !== "hq" && r.status === "normal" ? <PermButton perm={PERMS.campusClose} size="sm" variant="outline" onClick={() => void setStatus(r, "stop_new")}>{t("stopNew")}</PermButton> : null}
          {r.type !== "hq" && r.status === "stop_new" ? <PermButton perm={PERMS.campusClose} size="sm" variant="outline" onClick={() => void setStatus(r, "normal")}>{t("resume")}</PermButton> : null}
          {r.type !== "hq" && r.status === "stop_new" ? <PermButton perm={PERMS.campusClose} size="sm" variant="outline" onClick={() => void startClose(r)}>{t("close")}</PermButton> : null}
          {r.status === "closed" ? <PermButton perm={PERMS.campusClose} size="sm" variant="outline" onClick={() => void setStatus(r, "normal")}>{t("reopen")}</PermButton> : null}
        </div>
      ),
    },
  ];
  return (
    <section>
      <H2>{t("title")}</H2>
      {error ? <p role="alert" className="mb-2 text-sm text-red-600">{error}</p> : null}
      {message}
      {dialog}
      <Can perm={PERMS.campusAdd}>{!form ? <Button size="sm" className="mb-3" onClick={() => setForm({})}>{c("add")}</Button> : null}</Can>
      {form ? (
        <FormPanel
          title={form.row ? c("edit") : c("add")}
          fields={fields}
          initial={form.row ? { code: form.row.code, name: form.row.name, shortName: form.row.shortName ?? "", address: form.row.address ?? "", timezone: form.row.timezone } : {}}
          submitLabel={c("save")}
          cancelLabel={c("cancel")}
          onCancel={() => setForm(null)}
          onSubmit={async (p) => { if (await run(() => (form.row ? bff(`campuses/${form.row.id}`, { method: "PATCH", body: p }) : bff("campuses", { method: "POST", body: p })), c("saved"))) setForm(null); }}
        />
      ) : null}
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
      {closure ? (
        <Modal title={t("closeCheckFor", { name: closure.campus.name })} onClose={() => setClosure(null)}>
        <div className="text-sm">
          <ul className="mb-2 list-disc pl-5">
            <li>{t("students", { n: closure.data.students.count })}</li>
            <li>{t("staff", { n: closure.data.staffAssignments.count })}</li>
            <li>{closure.data.classes.implemented ? t("classes", { n: closure.data.classes.count }) : t("classesLater")}</li>
          </ul>
          <div className="flex gap-2 border-t border-border pt-3">
            <Button size="sm" disabled={closure.data.students.count + closure.data.staffAssignments.count + closure.data.classes.count > 0} onClick={async () => {
              const v = await ask(t("closeNow"), [{ name: "typed", label: t("typeName", { name: closure.campus.name }) }]);
              if (v === null) return;
              if (await setStatus(closure.campus, "closed", v.typed)) setClosure(null); else setMessage((m) => m);
            }}>{t("closeNow")}</Button>
            <Button size="sm" variant="outline" onClick={() => setClosure(null)}>{c("cancel")}</Button>
          </div>
        </div>
        </Modal>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- 部门（组织树）
interface DeptRow { id: string; name: string; parentId: string | null; sort: number; status: boolean; ancestors: string[] }

export function DeptsPage() {
  const t = useTranslations("pages.depts");
  const c = useTranslations("crud");
  const tt = useTable();
  const { rows, loading, error, reload } = useList<DeptRow>("depts");
  const { run, message } = useAct(reload);
  const [form, setForm] = React.useState<{ row?: DeptRow } | null>(null);
  // 按树的顺序排好：先父后子，同级按排序
  const ordered = React.useMemo(() => {
    const byParent = new Map<string | null, DeptRow[]>();
    for (const r of rows) byParent.set(r.parentId, [...(byParent.get(r.parentId) ?? []), r]);
    const out: Array<DeptRow & { depth: number }> = [];
    const walk = (parent: string | null, depth: number) => {
      for (const r of (byParent.get(parent) ?? []).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))) {
        out.push({ ...r, depth });
        walk(r.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [rows]);
  const parentOptions = ordered.filter((r) => !form?.row || !r.ancestors.includes(form.row.id)).map((r) => ({ value: r.id, label: `${"— ".repeat(r.depth)}${r.name}` }));
  const fields: Field[] = [
    { name: "name", label: t("name"), required: true },
    { name: "parentId", label: t("parent"), type: "select", options: parentOptions, required: !form?.row },
    { name: "sort", label: c("sort"), type: "number" },
    ...(form?.row ? [{ name: "status", label: c("enabled"), type: "checkbox" as const }] : []),
  ];
  const columns: Column<DeptRow & { depth: number }>[] = [
    { key: "name", header: t("name"), cell: (r) => <span style={{ paddingLeft: r.depth * 16 }}>{r.name}</span> },
    { key: "sort", header: c("sort"), cell: (r) => r.sort },
    { key: "status", header: c("status"), cell: (r) => (r.status ? c("enabled") : c("disabled")) },
    {
      key: "actions",
      header: "",
      cell: (r) => (
        <div className="flex gap-1">
          <PermButton perm={PERMS.deptAdd} size="sm" variant="outline" onClick={() => setForm({ row: undefined })}>{c("add")}</PermButton>
          <PermButton perm={PERMS.deptEdit} size="sm" variant="outline" onClick={() => setForm({ row: r })}>{c("edit")}</PermButton>
          <PermButton perm={PERMS.deptRemove} size="sm" variant="outline" onClick={() => window.confirm(c("confirmDelete", { name: r.name })) && void run(() => bff(`depts/${r.id}`, { method: "DELETE" }), c("done"))}>{c("delete")}</PermButton>
        </div>
      ),
    },
  ];
  return (
    <section>
      <H2>{t("title")}</H2>
      <p className="mb-2 text-sm text-muted">{t("hint")}</p>
      {error ? <p role="alert" className="mb-2 text-sm text-red-600">{error}</p> : null}
      {message}
      {form ? (
        <FormPanel
          key={form.row?.id ?? "new"}
          title={form.row ? c("edit") : c("add")}
          fields={fields}
          initial={form.row ? { name: form.row.name, parentId: form.row.parentId ?? "", sort: String(form.row.sort), status: form.row.status } : {}}
          submitLabel={c("save")}
          cancelLabel={c("cancel")}
          onCancel={() => setForm(null)}
          onSubmit={async (p) => { if (await run(() => (form.row ? bff(`depts/${form.row.id}`, { method: "PATCH", body: p }) : bff("depts", { method: "POST", body: p })), c("saved"))) setForm(null); }}
        />
      ) : null}
      <DataTable columns={columns} rows={ordered} rowKey={(r) => r.id} loading={loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
    </section>
  );
}

// ---------------------------------------------------------------- 参数
interface ParamRow { id: string; key: string; value: string; name: string; platformProvided: boolean }

export function ParamsPage() {
  const t = useTranslations("pages.params");
  const c = useTranslations("crud");
  const tm = useTranslations();
  const tt = useTable();
  const { rows, loading, error, reload } = useList<ParamRow & { nameKey: string | null }>("params");
  const { run, message } = useAct(reload);
  const [form, setForm] = React.useState<{ row?: ParamRow } | null>(null);
  const fields: Field[] = [
    { name: "key", label: t("key"), required: true, readOnly: !!form?.row },
    { name: "name", label: t("name"), required: true },
    { name: "value", label: t("value") },
  ];
  const columns: Column<ParamRow & { nameKey: string | null }>[] = [
    { key: "name", header: t("name"), cell: (r) => (r.nameKey && tm.has(r.nameKey) ? tm(r.nameKey) : r.name) },
    { key: "key", header: t("key"), cell: (r) => <code>{r.key}</code> },
    { key: "value", header: t("value"), cell: (r) => r.value },
    { key: "source", header: t("source"), cell: (r) => (r.platformProvided ? t("platform") : t("own")) },
    {
      key: "actions",
      header: "",
      cell: (r) => (r.platformProvided ? null : (
        <div className="flex gap-1">
          <PermButton perm={PERMS.paramEdit} size="sm" variant="outline" onClick={() => setForm({ row: r })}>{c("edit")}</PermButton>
          <PermButton perm={PERMS.paramRemove} size="sm" variant="outline" onClick={() => window.confirm(c("confirmDelete", { name: r.name })) && void run(() => bff(`params/${r.id}`, { method: "DELETE" }), c("done"))}>{c("delete")}</PermButton>
        </div>
      )),
    },
  ];
  return (
    <section>
      <H2>{t("title")}</H2>
      {error ? <p role="alert" className="mb-2 text-sm text-red-600">{error}</p> : null}
      {message}
      <Can perm={PERMS.paramAdd}>{!form ? <Button size="sm" className="mb-3" onClick={() => setForm({})}>{c("add")}</Button> : null}</Can>
      {form ? (
        <FormPanel
          title={form.row ? c("edit") : c("add")}
          fields={fields}
          initial={form.row ? { key: form.row.key, name: form.row.name, value: form.row.value } : {}}
          submitLabel={c("save")}
          cancelLabel={c("cancel")}
          onCancel={() => setForm(null)}
          onSubmit={async (p) => { if (await run(() => (form.row ? bff(`params/${form.row.id}`, { method: "PATCH", body: { value: p.value ?? "", name: p.name } }) : bff("params", { method: "POST", body: p })), c("saved"))) setForm(null); }}
        />
      ) : null}
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
    </section>
  );
}

// ---------------------------------------------------------------- 字典
interface DictType { id: string; code: string; name: string; nameKey: string | null; status: boolean; platformProvided: boolean }
interface DictItem { id: string; value: string; label: string; labelKey: string | null; sort: number; status: boolean }

export function DictsPage() {
  const t = useTranslations("pages.dicts");
  const c = useTranslations("crud");
  const tm = useTranslations();
  const tt = useTable();
  const types = useList<DictType>("dict-types");
  const [open, setOpen] = React.useState<DictType | null>(null);
  const { run, message } = useAct(types.reload);
  const [newType, setNewType] = React.useState(false);
  const columns: Column<DictType>[] = [
    { key: "name", header: t("name"), cell: (r) => (r.nameKey && tm.has(r.nameKey) ? tm(r.nameKey) : r.name) },
    { key: "code", header: t("code"), cell: (r) => <code>{r.code}</code> },
    { key: "source", header: t("source"), cell: (r) => (r.platformProvided ? t("platform") : t("own")) },
    { key: "status", header: c("status"), cell: (r) => (r.status ? c("enabled") : c("disabled")) },
    {
      key: "actions",
      header: "",
      cell: (r) => (
        <div className="flex gap-1">
          <Button size="sm" variant="outline" onClick={() => setOpen(r)}>{t("items")}</Button>
          {!r.platformProvided ? <PermButton perm={PERMS.dictRemove} size="sm" variant="outline" onClick={() => window.confirm(c("confirmDelete", { name: r.name })) && void run(() => bff(`dict-types/${r.id}`, { method: "DELETE" }), c("done"))}>{c("delete")}</PermButton> : null}
        </div>
      ),
    },
  ];
  return (
    <section>
      <H2>{t("title")}</H2>
      {types.error ? <p role="alert" className="mb-2 text-sm text-red-600">{types.error}</p> : null}
      {message}
      <Can perm={PERMS.dictAdd}>{!newType ? <Button size="sm" className="mb-3" onClick={() => setNewType(true)}>{c("add")}</Button> : null}</Can>
      {newType ? (
        <FormPanel title={c("add")} fields={[{ name: "code", label: t("code"), required: true }, { name: "name", label: t("name"), required: true }]} submitLabel={c("save")} cancelLabel={c("cancel")} onCancel={() => setNewType(false)}
          onSubmit={async (p) => { if (await run(() => bff("dict-types", { method: "POST", body: p }), c("saved"))) setNewType(false); }} />
      ) : null}
      <DataTable columns={columns} rows={types.rows} rowKey={(r) => r.id} loading={types.loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
      {open ? <DictItems type={open} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}

function DictItems({ type, onClose }: { type: DictType; onClose: () => void }) {
  const t = useTranslations("pages.dicts");
  const c = useTranslations("crud");
  const tm = useTranslations();
  const tt = useTable();
  const items = useList<DictItem>(`dict-types/${type.id}/items`);
  const { run, message } = useAct(items.reload);
  const [form, setForm] = React.useState<{ row?: DictItem } | null>(null);
  const columns: Column<DictItem>[] = [
    { key: "value", header: t("value"), cell: (r) => <code>{r.value}</code> },
    { key: "label", header: t("label"), cell: (r) => (r.labelKey && tm.has(r.labelKey) ? tm(r.labelKey) : r.label) },
    { key: "sort", header: c("sort"), cell: (r) => r.sort },
    { key: "status", header: c("status"), cell: (r) => (r.status ? c("enabled") : c("disabled")) },
    {
      key: "actions",
      header: "",
      cell: (r) => (type.platformProvided ? null : (
        <div className="flex gap-1">
          <PermButton perm={PERMS.dictEdit} size="sm" variant="outline" onClick={() => setForm({ row: r })}>{c("edit")}</PermButton>
          <PermButton perm={PERMS.dictRemove} size="sm" variant="outline" onClick={() => window.confirm(c("confirmDelete", { name: r.label })) && void run(() => bff(`dict-items/${r.id}`, { method: "DELETE" }), c("done"))}>{c("delete")}</PermButton>
        </div>
      )),
    },
  ];
  return (
    <Modal title={t("itemsOf", { name: type.name })} onClose={onClose}>
    <div>
      {message}
      {!type.platformProvided ? <Can perm={PERMS.dictAdd}>{!form ? <Button size="sm" className="mb-3" onClick={() => setForm({})}>{c("add")}</Button> : null}</Can> : <p className="mb-2 text-sm text-muted">{t("readOnly")}</p>}
      {form ? (
        <FormPanel key={form.row?.id ?? "new"} title={form.row ? c("edit") : c("add")}
          fields={[{ name: "value", label: t("value"), required: true, readOnly: !!form.row }, { name: "label", label: t("label"), required: true }, { name: "sort", label: c("sort"), type: "number" }, ...(form.row ? [{ name: "status", label: c("enabled"), type: "checkbox" as const }] : [])]}
          initial={form.row ? { value: form.row.value, label: form.row.label, sort: String(form.row.sort), status: form.row.status } : {}}
          submitLabel={c("save")} cancelLabel={c("cancel")} onCancel={() => setForm(null)}
          onSubmit={async (p) => { if (await run(() => (form.row ? bff(`dict-items/${form.row.id}`, { method: "PATCH", body: p }) : bff(`dict-types/${type.id}/items`, { method: "POST", body: p })), c("saved"))) setForm(null); }} />
      ) : null}
      <DataTable columns={columns} rows={items.rows} rowKey={(r) => r.id} loading={items.loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
      <div className="mt-3 border-t border-border pt-3"><Button size="sm" variant="outline" onClick={onClose}>{c("close")}</Button></div>
    </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- 操作日志
interface OpRow { id: string; username: string | null; method: string; path: string; status: number; durationMs: number; ip: string | null; createdAt: string; error: string | null }

export function OperationLogPage() {
  const t = useTranslations("pages.operationLog");
  const c = useTranslations("crud");
  const tt = useTable();
  const [page, setPage] = React.useState(1);
  const [filter, setFilter] = React.useState({ username: "", method: "" });
  const qs = `operation-logs?page=${page}&size=20${filter.username ? `&username=${encodeURIComponent(filter.username)}` : ""}${filter.method ? `&method=${filter.method}` : ""}`;
  const { rows, loading, error, reload } = useList<OpRow>(qs);
  const { run, message } = useAct(reload);
  const columns: Column<OpRow>[] = [
    { key: "time", header: t("time"), cell: (r) => when(r.createdAt) },
    { key: "user", header: t("user"), cell: (r) => r.username ?? "" },
    { key: "request", header: t("request"), cell: (r) => `${r.method} ${r.path}` },
    { key: "status", header: c("status"), cell: (r) => <span title={r.error ?? ""}>{r.status}</span> },
    { key: "ms", header: t("duration"), cell: (r) => `${r.durationMs} ms` },
    { key: "ip", header: t("ip"), cell: (r) => r.ip ?? "" },
  ];
  return (
    <section>
      <H2>{t("title")}</H2>
      {error ? <p role="alert" className="mb-2 text-sm text-red-600">{error}</p> : null}
      {message}
      <div className="mb-3 flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col gap-1">{t("user")}<input className="rounded-md border border-border bg-transparent px-2 py-1" value={filter.username} onChange={(e) => { setPage(1); setFilter({ ...filter, username: e.target.value }); }} /></label>
        <label className="flex flex-col gap-1">{t("method")}
          <select className="rounded-md border border-border bg-transparent px-2 py-1" value={filter.method} onChange={(e) => { setPage(1); setFilter({ ...filter, method: e.target.value }); }}>
            <option value="" />{["POST", "PUT", "PATCH", "DELETE"].map((m) => (<option key={m} value={m}>{m}</option>))}
          </select>
        </label>
        <PermButton perm={PERMS.operationLogClear} size="sm" variant="outline" onClick={() => window.confirm(t("confirmClear")) && void run(() => bff("operation-logs", { method: "DELETE" }), c("done"))}>{t("clear")}</PermButton>
      </div>
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} pagination={{ page, size: 20, hasMore: rows.length === 20, onPageChange: setPage }} />
    </section>
  );
}
