"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { ChevronDown, ChevronRight, ChevronsUpDown, ExternalLink, FileText, Folder, KeyRound, Link, Mail, Pencil, Plus, Power, ShieldCheck, Trash2, Unlock, UserCog } from "lucide-react";
import { IconButton, PermRowAction } from "../icon-button";
import { PERMS } from "@staredu/shared";
import { Button } from "@/components/ui/button";
import { bff } from "@/lib/bff";
import { Modal } from "../modal";
import { DataTable, type Column } from "../data-table";
import { Can, PermButton } from "../permissions";
import { submitIds, type TreeNode } from "../tree";
import { TreeSelect } from "../tree-select";
import { FormPanel, useAct, type Field } from "./crud";
import { useList } from "./use-api";

const H2 = ({ children }: { children: React.ReactNode }) => <h2 className="mb-3 text-lg font-semibold">{children}</h2>;
function useTable() {
  const t = useTranslations("table");
  return { empty: t("empty"), loading: t("loading"), labels: { actions: t("actions"), more: t("more"), selectAll: t("selectAll"), selectRow: t("selectRow"), clearSelection: t("clearSelection"), selected: (n: number) => t("selected", { n }), previous: t("previous"), next: t("next"), page: (p: number, n: number) => t("page", { page: p, pages: n }) } };
}
const Err = ({ error }: { error: string | null }) => (error ? <p role="alert" className="mb-2 text-sm text-red-600">{error}</p> : null);

// ---------------------------------------------------------------- 用户（账号）
interface AccountRow { id: string; username: string; email: string | null; status: string; isBuiltinAdmin: boolean; personId: string | null; roleIds: string[] }
interface RoleRow { id: string; code: string; name: string; kind: string; templateMissingCount?: number }
interface PersonRow { id: string; fullName: string; type: string }

export function UsersPage() {
  const t = useTranslations("pages.users");
  const c = useTranslations("crud");
  const tt = useTable();
  const [q, setQ] = React.useState("");
  const [page, setPage] = React.useState(1);
  const accounts = useList<AccountRow>(`accounts?page=${page}&size=20${q ? `&q=${encodeURIComponent(q)}` : ""}`);
  const roles = useList<RoleRow>("roles");
  const persons = useList<PersonRow>("persons");
  const { run, message } = useAct(accounts.reload);
  const [form, setForm] = React.useState(false);
  const [rolesFor, setRolesFor] = React.useState<AccountRow | null>(null);
  const [picked, setPicked] = React.useState<string[]>([]);
  const [temp, setTemp] = React.useState<{ username: string; password: string } | null>(null);
  const custom = roles.rows.filter((r) => r.kind === "custom");
  const fields: Field[] = [
    { name: "username", label: t("username"), required: true },
    { name: "email", label: t("email"), type: "email" },
    { name: "kind", label: t("kind"), type: "select", options: [{ value: "staff", label: t("staff") }, { value: "student", label: t("student") }] },
    { name: "personId", label: t("person"), type: "select", options: persons.rows.map((p) => ({ value: p.id, label: `${p.fullName} (${p.type})` })) },
  ];
  const act = (fn: () => Promise<unknown>, ok: string) => void run(fn, ok);
  const columns: Column<AccountRow>[] = [
    { key: "username", header: t("username"), cell: (r) => `${r.username}${r.isBuiltinAdmin ? ` (${t("builtin")})` : ""}` },
    { key: "email", header: t("email"), cell: (r) => r.email ?? "" },
    { key: "status", header: c("status"), cell: (r) => t(`status_${r.status}`) },
    { key: "roles", header: t("roles"), cell: (r) => r.roleIds.map((id) => roles.rows.find((x) => x.id === id)?.name ?? "").filter(Boolean).join(", ") },
    {
      key: "actions",
      header: "",
      cell: (r) => (
        <div className="flex flex-wrap gap-1">
          {!r.isBuiltinAdmin ? <PermRowAction perm={PERMS.userAssignRole} onClick={() => { setRolesFor(r); setPicked(r.roleIds.filter((id) => custom.some((x) => x.id === id))); }} icon={UserCog}>{t("assignRoles")}</PermRowAction> : null}
          {!r.isBuiltinAdmin ? <PermRowAction perm={PERMS.userEdit} onClick={() => act(() => bff(`accounts/${r.id}/status`, { method: "PATCH", body: { status: r.status === "disabled" ? "active" : "disabled" } }), c("done"))} icon={Power}>{r.status === "disabled" ? t("enable") : t("disable")}</PermRowAction> : null}
          {!r.isBuiltinAdmin ? <PermRowAction perm={PERMS.userResetPwd} onClick={() => act(() => bff(`accounts/${r.id}/invite`, { method: "POST" }), t("sent"))} icon={Mail}>{t("resendInvite")}</PermRowAction> : null}
          {!r.isBuiltinAdmin ? <PermRowAction perm={PERMS.userResetPwd} onClick={() => act(() => bff(`accounts/${r.id}/reset-link`, { method: "POST" }), t("sent"))} icon={Link}>{t("resetLink")}</PermRowAction> : null}
          {!r.isBuiltinAdmin ? <PermRowAction perm={PERMS.userResetPwd} onClick={() => window.confirm(t("confirmTemp", { name: r.username })) && void bff<{ password: string }>(`accounts/${r.id}/temp-password`, { method: "POST" }).then((x) => setTemp({ username: r.username, password: x.password }))} icon={KeyRound}>{t("tempPassword")}</PermRowAction> : null}
          {!r.isBuiltinAdmin ? <PermRowAction perm={PERMS.userEdit} onClick={() => act(() => bff(`accounts/${r.id}/unlock`, { method: "POST" }), t("unlocked"))} icon={Unlock}>{t("unlock")}</PermRowAction> : null}
        </div>
      ),
    },
  ];
  return (
    <section>
      <H2>{t("title")}</H2>
      <Err error={accounts.error} />
      {message}
      {temp ? (
        <Modal title={t("tempShown", { name: temp.username })} onClose={() => setTemp(null)}>
          <div role="alert" className="text-sm">
            <p>{t("tempShown", { name: temp.username })}</p>
            <p className="my-3 font-mono text-base" data-testid="temp-password">{temp.password}</p>
            <div className="border-t border-border pt-3"><Button size="sm" variant="outline" onClick={() => setTemp(null)}>{t("tempDone")}</Button></div>
          </div>
        </Modal>
      ) : null}
      <div className="mb-3 flex flex-wrap items-end gap-2 text-sm">
        <Can perm={PERMS.userAdd}>{!form ? <IconButton icon={Plus} label={c("add")} onClick={() => setForm(true)}/> : null}</Can>
        <label className="flex flex-col gap-1">{t("search")}<input className="rounded-md border border-border bg-transparent px-2 py-1" value={q} onChange={(e) => { setPage(1); setQ(e.target.value); }} /></label>
      </div>
      {form ? <FormPanel title={c("add")} fields={fields} submitLabel={c("save")} cancelLabel={c("cancel")} onCancel={() => setForm(false)} onSubmit={async (p) => { if (await run(() => bff("accounts", { method: "POST", body: p }), t("created"))) setForm(false); }} /> : null}
      {rolesFor ? (
        <Modal title={t("rolesOf", { name: rolesFor.username })} onClose={() => setRolesFor(null)}>
        <div className="text-sm">
          <div className="flex flex-wrap gap-3">
            {custom.map((r) => (
              <label key={r.id} className="flex items-center gap-1">
                <input type="checkbox" checked={picked.includes(r.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id))} />
                {r.name}
              </label>
            ))}
          </div>
          <div className="mt-4 flex gap-2 border-t border-border pt-3">
            <Button size="sm" onClick={async () => { if (await run(() => bff(`accounts/${rolesFor.id}/roles`, { method: "PUT", body: { roleIds: picked } }), c("saved"))) setRolesFor(null); }}>{c("save")}</Button>
            <Button size="sm" variant="outline" onClick={() => setRolesFor(null)}>{c("cancel")}</Button>
          </div>
        </div>
        </Modal>
      ) : null}
      <DataTable columns={columns} rows={accounts.rows} rowKey={(r) => r.id} loading={accounts.loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} pagination={{ page, size: 20, hasMore: accounts.rows.length === 20, onPageChange: setPage }} />
    </section>
  );
}

// ---------------------------------------------------------------- 角色
interface MenuTreeNode { id: string; name: string; nameKey: string | null; children?: MenuTreeNode[] }
interface ScopeSet { id: string; name: string; kind: string; platformProvided: boolean }

function toTree(nodes: MenuTreeNode[], label: (n: MenuTreeNode) => string): TreeNode[] {
  return nodes.map((n) => ({ id: n.id, label: label(n), children: n.children?.length ? toTree(n.children, label) : undefined }));
}

export function RolesPage() {
  const t = useTranslations("pages.roles");
  const c = useTranslations("crud");
  const tm = useTranslations();
  const tt = useTable();
  const roles = useList<RoleRow & { sort: number }>("roles");
  const { run, message } = useAct(roles.reload);
  const [form, setForm] = React.useState<{ row?: RoleRow } | null>(null);
  const [editing, setEditing] = React.useState<RoleRow | null>(null);
  const [upgrade, setUpgrade] = React.useState<{ role: RoleRow; missing: Array<{ menuId: string; name: string; type: string }> } | null>(null);
  const openUpgrade = (role: RoleRow) => void bff<{ missing: Array<{ menuId: string; name: string; type: string }> }>(`roles/${role.id}/template-diff`).then((d) => setUpgrade({ role, missing: d.missing })).catch(() => setUpgrade(null));
  const columns: Column<RoleRow>[] = [
    { key: "name", header: t("name"), cell: (r) => r.name },
    { key: "code", header: t("code"), cell: (r) => <code>{r.code}</code> },
    { key: "kind", header: t("kind"), cell: (r) => (r.kind === "custom" ? t("custom") : t("builtin")) },
    {
      key: "actions",
      header: "",
      cell: (r) => (r.kind !== "custom" ? null : (
        <div className="flex flex-wrap gap-1">
          <PermRowAction perm={PERMS.roleEdit} onClick={() => setForm({ row: r })} icon={Pencil}>{c("edit")}</PermRowAction>
          <PermRowAction perm={PERMS.roleAuthorize} onClick={() => setEditing(r)} icon={ShieldCheck}>{t("permissions")}</PermRowAction>
          <PermRowAction perm={PERMS.roleRemove} onClick={() => window.confirm(c("confirmDelete", { name: r.name })) && void run(() => bff(`roles/${r.id}`, { method: "DELETE" }), c("done"))} icon={Trash2} danger>{c("delete")}</PermRowAction>
          {r.templateMissingCount ? <PermButton perm={PERMS.roleAuthorize} size="sm" onClick={() => openUpgrade(r)}>{t("templateUpdate", { n: r.templateMissingCount })}</PermButton> : null}
        </div>
      )),
    },
  ];
  return (
    <section>
      <H2>{t("title")}</H2>
      <Err error={roles.error} />
      {message}
      <Can perm={PERMS.roleAdd}>{!form ? <IconButton icon={Plus} label={c("add")} onClick={() => setForm({})} className="mb-3"/> : null}</Can>
      {form ? (
        <FormPanel key={form.row?.id ?? "new"} title={form.row ? c("edit") : c("add")}
          fields={[{ name: "code", label: t("code"), required: true, readOnly: !!form.row }, { name: "name", label: t("name"), required: true }]}
          initial={form.row ? { code: form.row.code, name: form.row.name } : {}} submitLabel={c("save")} cancelLabel={c("cancel")} onCancel={() => setForm(null)}
          onSubmit={async (p) => { if (await run(() => (form.row ? bff(`roles/${form.row.id}`, { method: "PATCH", body: { name: p.name } }) : bff("roles", { method: "POST", body: p })), c("saved"))) setForm(null); }} />
      ) : null}
      <DataTable columns={columns} rows={roles.rows} rowKey={(r) => r.id} loading={roles.loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
      {upgrade ? (
        <Modal title={t("templateTitle", { name: upgrade.role.name })} onClose={() => setUpgrade(null)}>
        <div className="text-sm">
          <ul className="mb-2 list-disc pl-5">{upgrade.missing.map((m) => <li key={m.menuId}>{m.name}</li>)}</ul>
          <p className="mb-2 text-muted">{t("templateNote")}</p>
          <div className="flex gap-2 border-t border-border pt-3">
            <PermButton perm={PERMS.roleAuthorize} size="sm" onClick={() => void run(() => bff(`roles/${upgrade.role.id}/template-upgrade`, { method: "POST" }), t("templateDone")).then(() => setUpgrade(null))}>{t("templateApply")}</PermButton>
            <Button size="sm" variant="outline" onClick={() => setUpgrade(null)}>{c("cancel")}</Button>
          </div>
        </div>
        </Modal>
      ) : null}
      {editing ? <RolePermissions role={editing} label={(n) => (n.nameKey && tm.has(n.nameKey) ? tm(n.nameKey) : n.name)} onClose={() => setEditing(null)} /> : null}
    </section>
  );
}

function RolePermissions({ role, label, onClose }: { role: RoleRow; label: (n: MenuTreeNode) => string; onClose: () => void }) {
  const t = useTranslations("pages.roles");
  const c = useTranslations("crud");
  const tree = useList<MenuTreeNode>("roles/menu-tree");
  const sets = useList<ScopeSet>("data-scope-sets");
  const [menus, setMenus] = React.useState<string[] | null>(null);
  const [scopes, setScopes] = React.useState<string[]>([]);
  const [msg, setMsg] = React.useState<{ text: string; error: boolean } | null>(null);
  React.useEffect(() => {
    void bff<{ menuIds: string[]; dataScopeSetIds: string[] }>(`roles/${role.id}`).then((r) => { setMenus(r.menuIds); setScopes(r.dataScopeSetIds); });
  }, [role.id]);
  if (menus === null) return <Modal title={t("permissions")} onClose={onClose}><p className="text-sm text-muted">…</p></Modal>;
  const nodes = toTree(tree.rows, label);
  return (
    <Modal title={t("permissionsOf", { name: role.name })} onClose={onClose}>
    <div className="text-sm">
      <h4 className="mb-1 text-muted">{t("operations")}</h4>
      <TreeSelect label={t("operations")} nodes={nodes} value={menus} onChange={setMenus} />
      <h4 className="mb-1 mt-3 text-muted">{t("dataScope")}</h4>
      <div className="flex flex-wrap gap-3">
        {sets.rows.map((s) => (
          <label key={s.id} className="flex items-center gap-1">
            <input type="checkbox" checked={scopes.includes(s.id)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s.id] : scopes.filter((x) => x !== s.id))} />
            {s.platformProvided ? t(`scope_${s.kind}`) : s.name}
          </label>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-2 border-t border-border pt-3">
        <PermButton perm={PERMS.roleAuthorize} size="sm" onClick={async () => {
          try {
            await bff(`roles/${role.id}/menus`, { method: "PUT", body: { menuIds: submitIds(nodes, new Set(menus)) } });
            await bff(`roles/${role.id}/data-scopes`, { method: "PUT", body: { setIds: scopes } });
            setMsg({ text: c("saved"), error: false });
          } catch (e) {
            setMsg({ text: (e as Error).message, error: true });
          }
        }}>{c("save")}</PermButton>
        <Button size="sm" variant="outline" onClick={onClose}>{c("close")}</Button>
        {msg ? <span role={msg.error ? "alert" : "status"} className={msg.error ? "text-red-600" : "text-muted"}>{msg.text}</span> : null}
      </div>
    </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- 菜单
interface MenuRow { id: string; parentId: string | null; name: string; nameKey: string | null; type: string; route: string | null; sort: number; visible: boolean; status: boolean; platformProvided: boolean; entries: string[] }

export function MenusPage() {
  const t = useTranslations("pages.menus");
  const c = useTranslations("crud");
  const tm = useTranslations();
  const tt = useTable();
  const { rows, loading, error, reload } = useList<MenuRow>("menus");
  const { run, message } = useAct(reload);
  const [form, setForm] = React.useState<{ row?: MenuRow; parentId?: string } | null>(null);
  const [folded, setFolded] = React.useState<ReadonlySet<string>>(new Set());
  const ordered = React.useMemo(() => {
    const byParent = new Map<string | null, MenuRow[]>();
    for (const r of rows) byParent.set(r.parentId, [...(byParent.get(r.parentId) ?? []), r]);
    const out: Array<MenuRow & { depth: number }> = [];
    const walk = (p: string | null, depth: number) => { for (const r of (byParent.get(p) ?? []).sort((a, b) => a.sort - b.sort)) { out.push({ ...r, depth }); walk(r.id, depth + 1); } };
    walk(null, 0);
    return out.filter((r) => r.type !== "button");
  }, [rows]);
  const label = (r: MenuRow) => (r.nameKey && tm.has(r.nameKey) ? tm(r.nameKey) : r.name);
  const hasKids = React.useMemo(() => new Set(ordered.filter((r) => r.parentId).map((r) => r.parentId as string)), [ordered]);
  // 折叠的目录，它下面的行不显示（ordered 是先父后子的顺序）
  const visible = React.useMemo(() => {
    const out: Array<MenuRow & { depth: number }> = [];
    let hideBelow: number | null = null;
    for (const r of ordered) {
      if (hideBelow !== null && r.depth > hideBelow) continue;
      hideBelow = null;
      out.push(r);
      if (folded.has(r.id)) hideBelow = r.depth;
    }
    return out;
  }, [ordered, folded]);
  const foldable = [...hasKids];
  const allFolded = foldable.length > 0 && foldable.every((id) => folded.has(id));
  const fields: Field[] = form?.row
    ? [{ name: "name", label: t("name"), required: true }, { name: "route", label: t("route") }, { name: "sort", label: c("sort"), type: "number" }, { name: "visible", label: t("visible"), type: "checkbox" }, { name: "status", label: c("enabled"), type: "checkbox" }]
    : [
        { name: "name", label: t("name"), required: true },
        { name: "type", label: t("type"), type: "select", required: true, options: [{ value: "directory", label: t("directory") }, { value: "link", label: t("link") }] },
        { name: "route", label: t("routeHint") },
        { name: "parentId", label: t("parent"), type: "select", options: ordered.filter((r) => r.type === "directory").map((r) => ({ value: r.id, label: `${"— ".repeat(r.depth)}${label(r)}` })) },
        { name: "sort", label: c("sort"), type: "number" },
      ];
  const columns: Column<MenuRow & { depth: number }>[] = [
    {
      key: "name",
      header: t("name"),
      cell: (r) => {
        const Icon = r.type === "directory" ? Folder : r.type === "link" ? ExternalLink : FileText;
        const kids = hasKids.has(r.id);
        const isFolded = folded.has(r.id);
        return (
          <span className="flex items-center gap-1" style={{ paddingLeft: r.depth * 22 }}>
            {kids ? (
              <button type="button" aria-label={`${isFolded ? t("expand") : t("collapse")} ${label(r)}`} aria-expanded={!isFolded} className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-border/50" onClick={() => setFolded((f) => { const n = new Set(f); if (isFolded) n.delete(r.id); else n.add(r.id); return n; })}>
                {isFolded ? <ChevronRight aria-hidden className="h-4 w-4" /> : <ChevronDown aria-hidden className="h-4 w-4" />}
              </button>
            ) : <span aria-hidden className="w-6" />}
            <Icon aria-hidden className="h-4 w-4 shrink-0 text-muted" />
            <span className={r.type === "directory" ? "font-medium" : ""}>{label(r)}</span>
          </span>
        );
      },
    },
    { key: "type", header: t("type"), cell: (r) => t(r.type) },
    { key: "route", header: t("route"), cell: (r) => r.route ?? "" },
    { key: "source", header: t("source"), cell: (r) => (r.platformProvided ? t("platform") : t("own")) },
    { key: "entry", header: t("entry"), cell: (r) => (r.parentId ? "" : r.entries.length ? r.entries.join(", ") : t("unassigned")) },
    {
      key: "actions",
      header: "",
      cell: (r) => (r.platformProvided ? null : (
        <div className="flex gap-1">
          <PermRowAction perm={PERMS.menuEdit} onClick={() => setForm({ row: r })} icon={Pencil}>{c("edit")}</PermRowAction>
          {r.type === "directory" ? <PermRowAction perm={PERMS.menuAdd} onClick={() => setForm({ parentId: r.id })} icon={Plus}>{c("add")}</PermRowAction> : null}
          <PermRowAction perm={PERMS.menuRemove} onClick={() => window.confirm(c("confirmDelete", { name: r.name })) && void run(() => bff(`menus/${r.id}`, { method: "DELETE" }), c("done"))} icon={Trash2} danger>{c("delete")}</PermRowAction>
        </div>
      )),
    },
  ];
  return (
    <section>
      <H2>{t("title")}</H2>
      <p className="mb-2 text-sm text-muted">{t("hint")}</p>
      <Err error={error} />
      {message}
      <div className="mb-3 flex items-center gap-2">
        <Can perm={PERMS.menuAdd}><IconButton icon={Plus} label={c("add")} onClick={() => setForm({})} /></Can>
        <IconButton icon={ChevronsUpDown} label={allFolded ? t("expandAll") : t("collapseAll")} variant="outline" onClick={() => setFolded(allFolded ? new Set() : new Set(foldable))} />
      </div>
      {form ? (
        <FormPanel key={form.row?.id ?? `new-${form.parentId ?? ""}`} title={form.row ? c("edit") : c("add")} fields={fields}
          initial={form.row ? { name: form.row.name, route: form.row.route ?? "", sort: String(form.row.sort), visible: form.row.visible, status: form.row.status } : { parentId: form.parentId ?? "" }}
          submitLabel={c("save")} cancelLabel={c("cancel")} onCancel={() => setForm(null)}
          onSubmit={async (p) => { if (await run(() => (form.row ? bff(`menus/${form.row.id}`, { method: "PATCH", body: p }) : bff("menus", { method: "POST", body: p })), c("saved"))) setForm(null); }} />
      ) : null}
      <DataTable columns={columns} rows={visible} rowKey={(r) => r.id} selectable={false} loading={loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
    </section>
  );
}

// ---------------------------------------------------------------- 入口管理
interface EntriesData { entries: Array<{ code: string; name: string; menus: Array<{ menuId: string; name: string; nameKey: string | null; platformProvided: boolean }> }>; unassigned: Array<{ menuId: string; name: string }> }

export function EntriesPage() {
  const t = useTranslations("pages.entries");
  const c = useTranslations("crud");
  const tm = useTranslations();
  const [d, setD] = React.useState<EntriesData | null>(null);
  const own = useList<MenuRow>("menus");
  const [sel, setSel] = React.useState<Record<string, string[]>>({});
  const [msg, setMsg] = React.useState<{ text: string; error: boolean } | null>(null);
  const [editing, setEditing] = React.useState<string | null>(null);
  const load = React.useCallback(() => { void bff<EntriesData>("entries").then((x) => { setD(x); setSel(Object.fromEntries(x.entries.map((e) => [e.code, e.menus.filter((m) => !m.platformProvided).map((m) => m.menuId)]))); }); }, []);
  React.useEffect(load, [load]);
  if (!d) return <p className="text-sm text-muted">…</p>;
  const topOwn = own.rows.filter((m) => !m.parentId && !m.platformProvided);
  const label = (n: { name: string; nameKey?: string | null }) => (n.nameKey && tm.has(n.nameKey) ? tm(n.nameKey) : n.name);
  return (
    <section>
      <H2>{t("title")}</H2>
      <p className="mb-2 text-sm text-muted">{t("hint")}</p>
      {msg ? <p role={msg.error ? "alert" : "status"} className={`mb-2 text-sm ${msg.error ? "text-red-600" : "text-muted"}`}>{msg.text}</p> : null}
      {d.entries.map((e) => (
        <div key={e.code} className="mb-4 rounded-md border border-border p-3 text-sm">
          <h3 className="mb-2 font-medium">{t(`entry_${e.code}`)}</h3>
          <p className="mb-2 text-muted">{t("platformAssigned")}: {e.menus.filter((m) => m.platformProvided).map(label).join(", ") || "—"}</p>
          <p className="mb-2">{t("yourMenus")}: {topOwn.filter((m) => (sel[e.code] ?? []).includes(m.id)).map((m) => m.name).join(", ") || "—"}</p>
          <PermRowAction perm={PERMS.entryEdit} onClick={() => setEditing(e.code)} icon={Pencil}>{c("edit")}</PermRowAction>
          {editing === e.code ? (
          <Modal title={t(`entry_${e.code}`)} onClose={() => { setEditing(null); load(); }}>
          <div className="text-sm">
          <p className="mb-1">{t("yourMenus")}</p>
          <div className="mb-2 flex flex-wrap gap-3">
            {topOwn.length === 0 ? <span className="text-muted">{t("noOwnMenus")}</span> : topOwn.map((m) => (
              <label key={m.id} className="flex items-center gap-1">
                <input type="checkbox" checked={(sel[e.code] ?? []).includes(m.id)} onChange={(ev) => setSel({ ...sel, [e.code]: ev.target.checked ? [...(sel[e.code] ?? []), m.id] : (sel[e.code] ?? []).filter((x) => x !== m.id) })} />
                {m.name}
              </label>
            ))}
          </div>
          <div className="mt-4 flex gap-2 border-t border-border pt-3">
          <PermButton perm={PERMS.entryEdit} size="sm" onClick={async () => {
            try { await bff(`entries/${e.code}/menus`, { method: "PUT", body: { menus: (sel[e.code] ?? []).map((menuId, i) => ({ menuId, sort: i })) } }); setMsg({ text: c("saved"), error: false }); setEditing(null); load(); }
            catch (err) { setMsg({ text: (err as Error).message, error: true }); }
          }}>{c("save")}</PermButton>
          <Button size="sm" variant="outline" onClick={() => { setEditing(null); load(); }}>{c("cancel")}</Button>
          </div>
          </div>
          </Modal>
          ) : null}
        </div>
      ))}
      <p className="text-sm text-muted">{t("unassignedList")}: {d.unassigned.map((m) => m.name).join(", ") || "—"}</p>
    </section>
  );
}

// ---------------------------------------------------------------- 数据权限集
interface SetRow { id: string; name: string; kind: string; platformProvided: boolean; nodes: Array<{ deptId: string; includeChildren: boolean }> }
interface DeptNode { id: string; name: string; parentId: string | null }

export function DataScopesPage() {
  const t = useTranslations("pages.dataScopes");
  const c = useTranslations("crud");
  const tt = useTable();
  const sets = useList<SetRow>("data-scope-sets");
  const depts = useList<DeptNode>("depts");
  const { run, message } = useAct(sets.reload);
  const [form, setForm] = React.useState<{ row?: SetRow } | null>(null);
  const [name, setName] = React.useState("");
  const [picked, setPicked] = React.useState<string[]>([]);
  const [withChildren, setWithChildren] = React.useState(true);
  const tree: TreeNode[] = React.useMemo(() => {
    const kids = new Map<string | null, DeptNode[]>();
    for (const d of depts.rows) kids.set(d.parentId, [...(kids.get(d.parentId) ?? []), d]);
    const build = (p: string | null): TreeNode[] => (kids.get(p) ?? []).map((d) => ({ id: d.id, label: d.name, children: build(d.id) }));
    return build(null);
  }, [depts.rows]);
  const columns: Column<SetRow>[] = [
    { key: "name", header: t("name"), cell: (r) => (r.platformProvided ? t(`kind_${r.kind}`) : r.name) },
    { key: "source", header: t("source"), cell: (r) => (r.platformProvided ? t("builtin") : t("custom")) },
    { key: "nodes", header: t("nodes"), cell: (r) => (r.platformProvided ? "" : r.nodes.length) },
    {
      key: "actions",
      header: "",
      cell: (r) => (r.platformProvided ? null : (
        <div className="flex gap-1">
          <PermRowAction perm={PERMS.dataScopeEdit} onClick={() => { setForm({ row: r }); setName(r.name); setPicked(r.nodes.map((n) => n.deptId)); setWithChildren(r.nodes.every((n) => n.includeChildren)); }} icon={Pencil}>{c("edit")}</PermRowAction>
          <PermRowAction perm={PERMS.dataScopeRemove} onClick={() => window.confirm(c("confirmDelete", { name: r.name })) && void run(() => bff(`data-scope-sets/${r.id}`, { method: "DELETE" }), c("done"))} icon={Trash2} danger>{c("delete")}</PermRowAction>
        </div>
      )),
    },
  ];
  return (
    <section>
      <H2>{t("title")}</H2>
      <p className="mb-3 text-sm text-muted">{t("note")}</p>
      <Err error={sets.error} />
      {message}
      <Can perm={PERMS.dataScopeAdd}>{!form ? <IconButton icon={Plus} label={c("add")} onClick={() => { setForm({}); setName(""); setPicked([]); setWithChildren(true); }} className="mb-3"/> : null}</Can>
      {form ? (
        <Modal title={form.row ? c("edit") : c("add")} onClose={() => setForm(null)}>
        <form className="text-sm" onSubmit={async (e) => {
          e.preventDefault();
          const body = { name, nodes: picked.map((deptId) => ({ deptId, includeChildren: withChildren })) };
          if (await run(() => (form.row ? bff(`data-scope-sets/${form.row.id}`, { method: "PUT", body }) : bff("data-scope-sets", { method: "POST", body })), c("saved"))) setForm(null);
        }}>
          <label className="mb-2 flex flex-col gap-1">{t("name")}<input required className="rounded-md border border-border bg-transparent px-2 py-1" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <p className="mb-1 text-muted">{t("pick")}</p>
          <TreeSelect label={t("pick")} nodes={tree} value={picked} onChange={setPicked} cascade={false} />
          <label className="my-2 flex items-center gap-1"><input type="checkbox" checked={withChildren} onChange={(e) => setWithChildren(e.target.checked)} />{t("includeChildren")}</label>
          <div className="mt-3 flex gap-2 border-t border-border pt-3"><Button type="submit" size="sm" disabled={picked.length === 0}>{c("save")}</Button><Button type="button" size="sm" variant="outline" onClick={() => setForm(null)}>{c("cancel")}</Button></div>
        </form>
        </Modal>
      ) : null}
      <DataTable columns={columns} rows={sets.rows} rowKey={(r) => r.id} loading={sets.loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
    </section>
  );
}
