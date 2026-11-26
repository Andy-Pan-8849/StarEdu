"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { Ban, Building2, Check, ChevronDown, ChevronRight, ChevronsUpDown, Eraser, Landmark, List, Pencil, Play, Plus, RotateCcw, School, Trash2, Users } from "lucide-react";
import { IconButton, PermIconButton, PermRowAction, RowAction } from "../icon-button";
import { PERMS } from "@staredu/shared";
import { Button } from "@/components/ui/button";
import { bff } from "@/lib/bff";
import { Modal } from "../modal";
import { usePromptDialog } from "../prompt-dialog";
import { BrandNameContext } from "../brand-context";
import { DataTable, type Column } from "../data-table";
import { buildOrgTree, ROOT_ID, type CampusRow as OrgCampus, type DeptRow, type OrgNode } from "../org-tree";
import { Can } from "../permissions";
import { FormPanel, useAct, type Field } from "./crud";
import { useList } from "./use-api";

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "");
const H2 = ({ children }: { children: React.ReactNode }) => <h2 className="mb-3 text-lg font-semibold">{children}</h2>;

function useTable() {
  const t = useTranslations("table");
  return { empty: t("empty"), loading: t("loading"), labels: { actions: t("actions"), more: t("more"), selectAll: t("selectAll"), selectRow: t("selectRow"), clearSelection: t("clearSelection"), selected: (n: number) => t("selected", { n }), previous: t("previous"), next: t("next"), page: (p: number, n: number) => t("page", { page: p, pages: n }) } };
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
          <PermRowAction perm={PERMS.postEdit} onClick={() => setForm({ row: r })} icon={Pencil}>{c("edit")}</PermRowAction>
          <PermRowAction perm={PERMS.postRemove} onClick={() => window.confirm(c("confirmDelete", { name: r.name })) && void run(() => bff(`posts/${r.id}`, { method: "DELETE" }), c("done"))} icon={Trash2} danger>{c("delete")}</PermRowAction>
        </div>
      ),
    },
  ];
  return (
    <section>
      <H2>{t("title")}</H2>
      {error ? <p role="alert" className="mb-2 text-sm text-red-600">{error}</p> : null}
      {message}
      <Can perm={PERMS.postAdd}>{!form ? <IconButton icon={Plus} label={c("add")} onClick={() => setForm({})} className="mb-3"/> : null}</Can>
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
          <PermRowAction perm={PERMS.campusEdit} onClick={() => setForm({ row: r })} icon={Pencil}>{c("edit")}</PermRowAction>
          {r.type !== "hq" && r.status === "normal" ? <PermRowAction perm={PERMS.campusClose} onClick={() => void setStatus(r, "stop_new")} icon={Ban}>{t("stopNew")}</PermRowAction> : null}
          {r.type !== "hq" && r.status === "stop_new" ? <PermRowAction perm={PERMS.campusClose} onClick={() => void setStatus(r, "normal")} icon={Play}>{t("resume")}</PermRowAction> : null}
          {r.type !== "hq" && r.status === "stop_new" ? <PermRowAction perm={PERMS.campusClose} onClick={() => void startClose(r)} icon={Ban}>{t("close")}</PermRowAction> : null}
          {r.status === "closed" ? <PermRowAction perm={PERMS.campusClose} onClick={() => void setStatus(r, "normal")} icon={RotateCcw}>{t("reopen")}</PermRowAction> : null}
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
      <Can perm={PERMS.campusAdd}>{!form ? <IconButton icon={Plus} label={c("add")} onClick={() => setForm({})} className="mb-3"/> : null}</Can>
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
const KIND_ICON = { root: Building2, hq: Landmark, campus: School, dept: Users } as const;
interface OrgRow { node: OrgNode; depth: number; dept?: DeptRow }

/** 部门管理：一棵树形表格，每一行都能单独改（竞品式）：展开/折叠、行内改排序、修改、新增下级、删除。 */
export function DeptsPage() {
  const t = useTranslations("pages.depts");
  const c = useTranslations("crud");
  const tt = useTable();
  const depts = useList<DeptRow>("depts");
  const campuses = useList<OrgCampus>("campuses");
  const { rows, loading, error, reload } = depts;
  const { run, message } = useAct(reload);
  const brand = React.useContext(BrandNameContext);
  const [form, setForm] = React.useState<{ row?: DeptRow; parentId?: string } | null>(null);
  const [folded, setFolded] = React.useState<ReadonlySet<string>>(new Set());
  const [sortEdits, setSortEdits] = React.useState<Record<string, string>>({});
  const root = React.useMemo(() => buildOrgTree(rows, campuses.rows, brand || "StarIT"), [rows, campuses.rows, brand]);
  const byId = React.useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const campusDeptIds = React.useMemo(() => new Set(campuses.rows.map((x) => x.deptId)), [campuses.rows]);
  const hqDept = root.children[0];
  // 树按展开状态摊平成可见的行
  const visible = React.useMemo(() => {
    const out: OrgRow[] = [];
    const walk = (n: OrgNode, depth: number) => {
      out.push({ node: n, depth, dept: byId.get(n.id) });
      if (!folded.has(n.id)) for (const ch of n.children) walk(ch, depth + 1);
    };
    walk(root, 0);
    return out;
  }, [root, byId, folded]);
  const expandable = React.useMemo(() => { const ids: string[] = []; const walk = (n: OrgNode) => { if (n.children.length) ids.push(n.id); n.children.forEach(walk); }; walk(root); return ids; }, [root]);
  const allFolded = expandable.length > 0 && expandable.every((id) => folded.has(id));
  const dirty = Object.entries(sortEdits).filter(([id, v]) => byId.get(id) && String(byId.get(id)!.sort) !== v);

  const parentOptions = rows.filter((r) => !form?.row || !r.ancestors.includes(form.row.id)).map((r) => ({ value: r.id, label: r.name }));
  const fields: Field[] = [
    { name: "name", label: t("name"), required: true },
    { name: "parentId", label: t("parent"), type: "select", options: parentOptions, required: !form?.row },
    { name: "sort", label: c("sort"), type: "number" },
    ...(form?.row ? [{ name: "status", label: c("enabled"), type: "checkbox" as const }] : []),
  ];
  const remove = (r: DeptRow) => window.confirm(c("confirmDelete", { name: r.name })) && void run(() => bff(`depts/${r.id}`, { method: "DELETE" }), c("done"));
  const saveSort = () => run(async () => { for (const [id, v] of dirty) await bff(`depts/${id}`, { method: "PATCH", body: { sort: Number(v) } }); }, c("saved")).then(() => setSortEdits({}));

  const columns: Column<OrgRow>[] = [
    {
      key: "name",
      header: t("name"),
      cell: (r) => {
        const Icon = KIND_ICON[r.node.kind];
        const has = r.node.children.length > 0;
        const isFolded = folded.has(r.node.id);
        return (
          <span className="flex items-center gap-1" style={{ paddingLeft: r.depth * 22 }}>
            {has ? (
              <button type="button" aria-label={`${isFolded ? t("expand") : t("collapse")} ${r.node.label}`} aria-expanded={!isFolded} className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-border/50" onClick={() => setFolded((f) => { const n = new Set(f); if (isFolded) n.delete(r.node.id); else n.add(r.node.id); return n; })}>
                {isFolded ? <ChevronRight aria-hidden className="h-4 w-4" /> : <ChevronDown aria-hidden className="h-4 w-4" />}
              </button>
            ) : <span aria-hidden className="w-6" />}
            <Icon aria-hidden className="h-4 w-4 shrink-0 text-muted" />
            <span className={r.node.kind === "dept" ? "" : "font-medium"}>{r.node.label}</span>
            {r.node.kind === "hq" ? <span className="ml-1 rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">{t("hq")}</span> : null}
          </span>
        );
      },
    },
    {
      key: "sort",
      header: c("sort"),
      cell: (r) => (r.dept && !campusDeptIds.has(r.dept.id) ? (
        <input type="number" aria-label={`${c("sort")} ${r.node.label}`} className="w-20 rounded-md border border-border bg-transparent px-2 py-1" value={sortEdits[r.dept.id] ?? String(r.dept.sort)} onChange={(e) => setSortEdits((m) => ({ ...m, [r.dept!.id]: e.target.value }))} onClick={(e) => e.stopPropagation()} />
      ) : <span className="text-muted">—</span>),
    },
    {
      key: "status",
      header: c("status"),
      cell: (r) => (r.dept ? <span className={r.dept.status ? "rounded bg-green-50 px-2 py-0.5 text-xs text-green-700 dark:bg-green-950 dark:text-green-300" : "rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500 dark:bg-slate-800"}>{r.dept.status ? c("enabled") : c("disabled")}</span> : null),
    },
    { key: "created", header: t("createdAt"), cell: (r) => (r.dept?.createdAt ? new Date(r.dept.createdAt).toLocaleString() : "") },
    {
      key: "actions",
      header: "",
      cell: (r) => {
        if (r.node.kind === "root") return null; // 公司只是最上面的名字，不是部门
        const d = r.dept;
        const campus = d ? campusDeptIds.has(d.id) : false;
        return (
          <>
            {d && !campus ? <PermRowAction perm={PERMS.deptEdit} onClick={() => setForm({ row: d })} icon={Pencil}>{c("edit")}</PermRowAction> : null}
            {d ? <PermRowAction perm={PERMS.deptAdd} onClick={() => setForm({ parentId: d.id })} icon={Plus}>{c("add")}</PermRowAction> : null}
            {d && !campus ? <PermRowAction perm={PERMS.deptRemove} onClick={() => remove(d)} icon={Trash2} danger>{c("delete")}</PermRowAction> : null}
          </>
        );
      },
    },
  ];
  return (
    <section>
      <H2>{t("title")}</H2>
      <p className="mb-3 text-sm text-muted">{t("hint")}</p>
      {error ? <p role="alert" className="mb-2 text-sm text-red-600">{error}</p> : null}
      {message}
      <div className="mb-3 flex items-center gap-2">
        <PermIconButton perm={PERMS.deptAdd} icon={Plus} label={c("add")} onClick={() => setForm({ parentId: hqDept?.id })} />
        <PermIconButton perm={PERMS.deptEdit} icon={Check} label={t("saveSort")} variant="outline" disabled={dirty.length === 0} onClick={() => void saveSort()} />
        <IconButton icon={ChevronsUpDown} label={allFolded ? t("expandAll") : t("collapseAll")} variant="outline" onClick={() => setFolded(allFolded ? new Set() : new Set(expandable.filter((id) => id !== ROOT_ID)))} />
      </div>
      {form ? (
        <FormPanel
          key={form.row?.id ?? "new"}
          title={form.row ? c("edit") : c("add")}
          fields={fields}
          initial={form.row ? { name: form.row.name, parentId: form.row.parentId ?? "", sort: String(form.row.sort), status: form.row.status } : { parentId: form.parentId ?? "" }}
          submitLabel={c("save")}
          cancelLabel={c("cancel")}
          onCancel={() => setForm(null)}
          onSubmit={async (p) => { if (await run(() => (form.row ? bff(`depts/${form.row.id}`, { method: "PATCH", body: p }) : bff("depts", { method: "POST", body: p })), c("saved"))) setForm(null); }}
        />
      ) : null}
      <DataTable columns={columns} rows={visible} rowKey={(r) => r.node.id} selectable={false} loading={loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
    </section>
  );
}

// ---------------------------------------------------------------- 参数
interface ParamRow { id: string; key: string; value: string; name: string; remark: string | null; platformProvided: boolean; overridden: boolean; defaultValue: string | null }

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
    { name: "name", label: t("name"), required: true, readOnly: !!form?.row?.platformProvided || !!form?.row?.overridden },
    { name: "value", label: t("value") },
    { name: "remark", label: t("remark"), type: "textarea", readOnly: !!form?.row?.platformProvided },
  ];
  const columns: Column<ParamRow & { nameKey: string | null }>[] = [
    { key: "name", header: t("name"), cell: (r) => (r.nameKey && tm.has(r.nameKey) ? tm(r.nameKey) : r.name) },
    { key: "key", header: t("key"), cell: (r) => <code>{r.key}</code> },
    { key: "value", header: t("value"), cell: (r) => r.value },
    { key: "remark", header: t("remark"), cell: (r) => <span className="block max-w-md whitespace-normal text-muted">{tm.has(`paramRemark.${r.key}`) ? tm(`paramRemark.${r.key}`) : (r.remark ?? "")}</span> },
    { key: "source", header: t("source"), cell: (r) => (r.platformProvided ? t("platform") : r.overridden ? t("customized") : t("own")) },
    {
      key: "actions",
      header: "",
      cell: (r) => (
        <div className="flex gap-1">
          <PermRowAction perm={PERMS.paramEdit} onClick={() => setForm({ row: r })} icon={Pencil}>{r.platformProvided ? t("customize") : c("edit")}</PermRowAction>
          {!r.platformProvided && r.overridden ? <PermRowAction perm={PERMS.paramRemove} onClick={() => window.confirm(t("confirmRestore")) && void run(() => bff(`params/${r.id}`, { method: "DELETE" }), c("done"))} icon={RotateCcw}>{t("restoreDefault")}</PermRowAction> : null}
          {!r.platformProvided && !r.overridden ? <PermRowAction perm={PERMS.paramRemove} onClick={() => window.confirm(c("confirmDelete", { name: r.name })) && void run(() => bff(`params/${r.id}`, { method: "DELETE" }), c("done"))} icon={Trash2} danger>{c("delete")}</PermRowAction> : null}
        </div>
      ),
    },
  ];
  return (
    <section>
      <H2>{t("title")}</H2>
      {error ? <p role="alert" className="mb-2 text-sm text-red-600">{error}</p> : null}
      {message}
      <Can perm={PERMS.paramAdd}>{!form ? <IconButton icon={Plus} label={c("add")} onClick={() => setForm({})} className="mb-3"/> : null}</Can>
      {form ? (
        <FormPanel
          title={form.row ? c("edit") : c("add")}
          fields={fields}
          initial={form.row ? { key: form.row.key, name: form.row.name, value: form.row.value, remark: form.row.remark ?? "" } : {}}
          submitLabel={c("save")}
          cancelLabel={c("cancel")}
          onCancel={() => setForm(null)}
          onSubmit={async (p) => { if (await run(() => (form.row?.platformProvided ? bff("params", { method: "POST", body: { key: form.row.key, name: form.row.name, value: p.value ?? "", ...(p.remark ? { remark: p.remark } : {}) } }) : form.row ? bff(`params/${form.row.id}`, { method: "PATCH", body: { value: p.value ?? "", name: p.name, remark: p.remark ? p.remark : null } }) : bff("params", { method: "POST", body: p })), c("saved"))) setForm(null); }}
        />
      ) : null}
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
    </section>
  );
}

// ---------------------------------------------------------------- 字典
interface DictType { id: string; code: string; name: string; nameKey: string | null; remark: string | null; status: boolean; platformProvided: boolean }
interface DictItem { id: string; tenantId: string | null; value: string; label: string; labelKey: string | null; remark: string | null; sort: number; status: boolean }

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
    { key: "remark", header: t("remark"), cell: (r) => <span className="block max-w-md whitespace-normal text-muted">{r.platformProvided && tm.has(`dictRemark.${r.code}`) ? tm(`dictRemark.${r.code}`) : (r.remark ?? "")}</span> },
    { key: "source", header: t("source"), cell: (r) => (r.platformProvided ? t("platform") : t("own")) },
    { key: "status", header: c("status"), cell: (r) => (r.status ? c("enabled") : c("disabled")) },
    {
      key: "actions",
      header: "",
      cell: (r) => (
        <div className="flex gap-1">
          <RowAction onClick={() => setOpen(r)} icon={List}>{t("items")}</RowAction>
          {!r.platformProvided ? <PermRowAction perm={PERMS.dictRemove} onClick={() => window.confirm(c("confirmDelete", { name: r.name })) && void run(() => bff(`dict-types/${r.id}`, { method: "DELETE" }), c("done"))} icon={Trash2} danger>{c("delete")}</PermRowAction> : null}
        </div>
      ),
    },
  ];
  return (
    <section>
      <H2>{t("title")}</H2>
      {types.error ? <p role="alert" className="mb-2 text-sm text-red-600">{types.error}</p> : null}
      {message}
      <Can perm={PERMS.dictAdd}>{!newType ? <IconButton icon={Plus} label={c("add")} onClick={() => setNewType(true)} className="mb-3"/> : null}</Can>
      {newType ? (
        <FormPanel title={c("add")} fields={[{ name: "code", label: t("code"), required: true }, { name: "name", label: t("name"), required: true }, { name: "remark", label: t("remark"), type: "textarea" }]} submitLabel={c("save")} cancelLabel={c("cancel")} onCancel={() => setNewType(false)}
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
    { key: "remark", header: t("remark"), cell: (r) => <span className="text-muted">{r.remark ?? ""}</span> },
    { key: "sort", header: c("sort"), cell: (r) => r.sort },
    { key: "status", header: c("status"), cell: (r) => (r.status ? c("enabled") : c("disabled")) },
    {
      key: "actions",
      header: "",
      cell: (r) => (r.tenantId === null ? null : (
        <div className="flex gap-1">
          <PermRowAction perm={PERMS.dictEdit} onClick={() => setForm({ row: r })} icon={Pencil}>{c("edit")}</PermRowAction>
          <PermRowAction perm={PERMS.dictRemove} onClick={() => window.confirm(c("confirmDelete", { name: r.label })) && void run(() => bff(`dict-items/${r.id}`, { method: "DELETE" }), c("done"))} icon={Trash2} danger>{c("delete")}</PermRowAction>
        </div>
      )),
    },
  ];
  return (
    <Modal title={t("itemsOf", { name: type.name })} onClose={onClose}>
    <div>
      {message}
      {type.platformProvided ? <p className="mb-2 text-sm text-muted">{t("readOnly")}</p> : null}
      <Can perm={PERMS.dictAdd}>{!form ? <IconButton icon={Plus} label={c("add")} onClick={() => setForm({})} className="mb-3"/> : null}</Can>
      {form ? (
        <FormPanel key={form.row?.id ?? "new"} title={form.row ? c("edit") : c("add")}
          fields={[{ name: "value", label: t("value"), required: true, readOnly: !!form.row }, { name: "label", label: t("label"), required: true }, { name: "remark", label: t("remark"), type: "textarea" }, { name: "sort", label: c("sort"), type: "number" }, ...(form.row ? [{ name: "status", label: c("enabled"), type: "checkbox" as const }] : [])]}
          initial={form.row ? { value: form.row.value, label: form.row.label, remark: form.row.remark ?? "", sort: String(form.row.sort), status: form.row.status } : {}}
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
        <PermRowAction perm={PERMS.operationLogClear} onClick={() => window.confirm(t("confirmClear")) && void run(() => bff("operation-logs", { method: "DELETE" }), c("done"))} icon={Eraser}>{t("clear")}</PermRowAction>
      </div>
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} pagination={{ page, size: 20, hasMore: rows.length === 20, onPageChange: setPage }} />
    </section>
  );
}
