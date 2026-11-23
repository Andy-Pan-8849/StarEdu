"use client";

// 平台控制台的 5 个页面：平台账号、平台角色、菜单、入口分配、平台公告。接口在 B3/B17 已有，这里只补页面。
import { useTranslations } from "next-intl";
import * as React from "react";
import { Plus } from "lucide-react";
import { IconButton } from "../icon-button";
import { PERMS } from "@staredu/shared";
import { Button } from "@/components/ui/button";
import { bff } from "@/lib/bff";
import { Modal } from "../modal";
import { DataTable, type Column } from "../data-table";
import { Can, PermButton } from "../permissions";
import { FormPanel, useAct, type Field } from "./crud";
import { useList } from "./use-api";

const H2 = ({ children }: { children: React.ReactNode }) => <h2 className="mb-3 text-lg font-semibold">{children}</h2>;
const Err = ({ error }: { error: string | null }) => (error ? <p role="alert" className="mb-2 text-sm text-red-600">{error}</p> : null);
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "");
function useTable() {
  const t = useTranslations("table");
  return { empty: t("empty"), loading: t("loading"), labels: { actions: t("actions"), selectAll: t("selectAll"), selectRow: t("selectRow"), clearSelection: t("clearSelection"), selected: (n: number) => t("selected", { n }), previous: t("previous"), next: t("next"), page: (p: number, n: number) => t("page", { page: p, pages: n }) } };
}

interface PRole { id: string; code: string; name: string; kind: string; sort: number }
interface PAccount { id: string; username: string; email: string | null; status: string; isBuiltin: boolean; roleIds: string[] }

// ---------------------------------------------------------------- 平台账号
export function PlatformAccountsPage() {
  const t = useTranslations("pages.platformAccounts");
  const c = useTranslations("crud");
  const tt = useTable();
  const accounts = useList<PAccount>("accounts");
  const roles = useList<PRole>("roles");
  const { run, message } = useAct(accounts.reload);
  const [form, setForm] = React.useState(false);
  const [rolesFor, setRolesFor] = React.useState<PAccount | null>(null);
  const [picked, setPicked] = React.useState<string[]>([]);
  const custom = roles.rows.filter((r) => r.kind === "custom");
  const fields: Field[] = [
    { name: "username", label: t("username"), required: true },
    { name: "email", label: t("email"), type: "email", required: true },
  ];
  const columns: Column<PAccount>[] = [
    { key: "username", header: t("username"), cell: (r) => `${r.username}${r.isBuiltin ? ` (${t("builtin")})` : ""}` },
    { key: "email", header: t("email"), cell: (r) => r.email ?? "" },
    { key: "status", header: c("status"), cell: (r) => t(`status_${r.status}`) },
    { key: "roles", header: t("roles"), cell: (r) => r.roleIds.map((id) => roles.rows.find((x) => x.id === id)?.name ?? "").filter(Boolean).join(", ") },
    {
      key: "actions",
      header: "",
      cell: (r) => (r.isBuiltin ? null : (
        <div className="flex flex-wrap gap-1">
          <PermButton perm={PERMS.platformAccountAssignRole} size="sm" variant="outline" onClick={() => { setRolesFor(r); setPicked(r.roleIds.filter((id) => custom.some((x) => x.id === id))); }}>{t("assignRoles")}</PermButton>
          <PermButton perm={PERMS.platformAccountEdit} size="sm" variant="outline" onClick={() => void run(() => bff(`accounts/${r.id}/status`, { method: "PATCH", body: { status: r.status === "disabled" ? "active" : "disabled" } }), c("done"))}>{r.status === "disabled" ? t("enable") : t("disable")}</PermButton>
        </div>
      )),
    },
  ];
  return (
    <section>
      <H2>{t("title")}</H2>
      <Err error={accounts.error} />
      {message}
      <div className="mb-3 text-sm"><Can perm={PERMS.platformAccountAdd}>{!form ? <IconButton icon={Plus} label={c("add")} onClick={() => setForm(true)}/> : null}</Can></div>
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
      <DataTable columns={columns} rows={accounts.rows} rowKey={(r) => r.id} loading={accounts.loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
    </section>
  );
}

// ---------------------------------------------------------------- 平台角色
interface MenuNode { id: string; name: string; children?: MenuNode[] }
const flatten = (nodes: MenuNode[], depth = 0): Array<{ id: string; name: string; depth: number }> =>
  nodes.flatMap((n) => [{ id: n.id, name: n.name, depth }, ...flatten(n.children ?? [], depth + 1)]);

export function PlatformRolesPage() {
  const t = useTranslations("pages.platformRoles");
  const c = useTranslations("crud");
  const tt = useTable();
  const roles = useList<PRole>("roles");
  const tree = useList<MenuNode>("roles/menu-tree");
  const { run, message } = useAct(roles.reload);
  const [form, setForm] = React.useState(false);
  const [authFor, setAuthFor] = React.useState<PRole | null>(null);
  const [picked, setPicked] = React.useState<string[]>([]);
  const items = React.useMemo(() => flatten(tree.rows), [tree.rows]);
  const open = (r: PRole) => void bff<{ menuIds: string[] }>(`roles/${r.id}`).then((d) => { setAuthFor(r); setPicked(d.menuIds); });
  const columns: Column<PRole>[] = [
    { key: "name", header: t("name"), cell: (r) => r.name },
    { key: "code", header: t("code"), cell: (r) => <code>{r.code}</code> },
    { key: "kind", header: t("kind"), cell: (r) => (r.kind === "custom" ? t("custom") : t("builtin")) },
    {
      key: "actions",
      header: "",
      cell: (r) => (r.kind !== "custom" ? null : (
        <div className="flex flex-wrap gap-1">
          <PermButton perm={PERMS.platformRoleAuthorize} size="sm" variant="outline" onClick={() => open(r)}>{t("permissions")}</PermButton>
          <PermButton perm={PERMS.platformRoleRemove} size="sm" variant="outline" onClick={() => window.confirm(c("confirmDelete", { name: r.name })) && void run(() => bff(`roles/${r.id}`, { method: "DELETE" }), c("done"))}>{c("delete")}</PermButton>
        </div>
      )),
    },
  ];
  return (
    <section>
      <H2>{t("title")}</H2>
      <Err error={roles.error} />
      {message}
      <div className="mb-3 text-sm"><Can perm={PERMS.platformRoleAdd}>{!form ? <IconButton icon={Plus} label={c("add")} onClick={() => setForm(true)}/> : null}</Can></div>
      {form ? (
        <FormPanel
          title={c("add")}
          fields={[{ name: "code", label: t("code"), required: true }, { name: "name", label: t("name"), required: true }, { name: "sort", label: t("sort"), type: "number" }]}
          submitLabel={c("save")}
          cancelLabel={c("cancel")}
          onCancel={() => setForm(false)}
          onSubmit={async (p) => { if (await run(() => bff("roles", { method: "POST", body: p }), c("saved"))) setForm(false); }}
        />
      ) : null}
      {authFor ? (
        <Modal title={t("permissionsOf", { name: authFor.name })} onClose={() => setAuthFor(null)}>
        <div className="text-sm">
          <ul className="max-h-72 overflow-auto">
            {items.map((m) => (
              <li key={m.id} style={{ paddingLeft: m.depth * 16 }}>
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={picked.includes(m.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, m.id] : picked.filter((x) => x !== m.id))} />
                  {m.name}
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex gap-2 border-t border-border pt-3">
            <Button size="sm" onClick={async () => { if (await run(() => bff(`roles/${authFor.id}/menus`, { method: "PUT", body: { menuIds: picked } }), c("saved"))) setAuthFor(null); }}>{c("save")}</Button>
            <Button size="sm" variant="outline" onClick={() => setAuthFor(null)}>{c("cancel")}</Button>
          </div>
        </div>
        </Modal>
      ) : null}
      <DataTable columns={columns} rows={roles.rows} rowKey={(r) => r.id} loading={roles.loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
    </section>
  );
}

// ---------------------------------------------------------------- 菜单
interface MenuRow { id: string; parentId: string | null; code: string; name: string; type: string; route: string | null; perms: string | null; sort: number; visible: boolean; status: boolean; entries: string[] }

export function PlatformMenusPage() {
  const t = useTranslations("pages.platformMenus");
  const c = useTranslations("crud");
  const tt = useTable();
  const menus = useList<MenuRow>("menus");
  const { run, message } = useAct(menus.reload);
  const patch = (r: MenuRow, body: Record<string, unknown>) => void run(() => bff(`menus/${r.id}`, { method: "PATCH", body }), c("done"));
  const rows = React.useMemo(() => [...menus.rows].sort((a, b) => a.code.localeCompare(b.code)), [menus.rows]);
  const columns: Column<MenuRow>[] = [
    { key: "name", header: t("name"), cell: (r) => r.name },
    { key: "code", header: t("code"), cell: (r) => <code>{r.code}</code> },
    { key: "type", header: t("type"), cell: (r) => r.type },
    { key: "entries", header: t("entries"), cell: (r) => r.entries.join(", ") },
    { key: "visible", header: t("visible"), cell: (r) => (r.visible ? "✓" : "–") },
    { key: "status", header: t("enabled"), cell: (r) => (r.status ? "✓" : "–") },
    {
      key: "actions",
      header: "",
      cell: (r) => (
        <div className="flex flex-wrap gap-1">
          <PermButton perm={PERMS.platformMenuEdit} size="sm" variant="outline" onClick={() => patch(r, { visible: !r.visible })}>{r.visible ? t("hide") : t("show")}</PermButton>
          <PermButton perm={PERMS.platformMenuEdit} size="sm" variant="outline" onClick={() => patch(r, { status: !r.status })}>{r.status ? t("disable") : t("enable")}</PermButton>
        </div>
      ),
    },
  ];
  return (
    <section>
      <H2>{t("title")}</H2>
      <p className="mb-2 text-sm text-muted">{t("hint")}</p>
      <Err error={menus.error} />
      {message}
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={menus.loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
    </section>
  );
}

// ---------------------------------------------------------------- 入口分配
interface EntryRow { code: string; name: string; menus: Array<{ menuId: string; sort: number; name?: string }> }

export function PlatformEntriesPage() {
  const t = useTranslations("pages.platformEntries");
  const c = useTranslations("crud");
  const entries = useList<EntryRow>("entries");
  const menus = useList<MenuRow>("menus");
  const { run, message } = useAct(entries.reload);
  const [editing, setEditing] = React.useState<{ code: string; picked: string[] } | null>(null);
  const tops = menus.rows.filter((m) => m.parentId === null).sort((a, b) => a.sort - b.sort);
  return (
    <section>
      <H2>{t("title")}</H2>
      <p className="mb-2 text-sm text-muted">{t("hint")}</p>
      <Err error={entries.error} />
      {message}
      <ul className="space-y-2 text-sm">
        {entries.rows.map((e) => (
          <li key={e.code} className="rounded-md border border-border p-3">
            <div className="font-medium">{e.name} <code className="text-muted">{e.code}</code></div>
            {editing?.code === e.code ? (
              <div className="mt-2">
                <div className="flex flex-wrap gap-3">
                  {tops.map((m) => (
                    <label key={m.id} className="flex items-center gap-1">
                      <input type="checkbox" checked={editing.picked.includes(m.id)} onChange={(ev) => setEditing({ code: e.code, picked: ev.target.checked ? [...editing.picked, m.id] : editing.picked.filter((x) => x !== m.id) })} />
                      {m.name}
                    </label>
                  ))}
                </div>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={async () => {
                    const body = { menus: editing.picked.map((menuId) => ({ menuId, sort: tops.find((m) => m.id === menuId)?.sort ?? 0 })) };
                    if (await run(() => bff(`entries/${e.code}/menus`, { method: "PUT", body }), c("saved"))) setEditing(null);
                  }}>{c("save")}</Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing(null)}>{c("cancel")}</Button>
                </div>
              </div>
            ) : (
              <div className="mt-1 flex items-center gap-3">
                <span>{e.menus.length ? e.menus.map((m) => m.name ?? m.menuId).join(", ") : t("none")}</span>
                <PermButton perm={PERMS.platformEntryEdit} size="sm" variant="outline" onClick={() => setEditing({ code: e.code, picked: e.menus.map((m) => m.menuId) })}>{t("assign")}</PermButton>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- 平台公告
interface PAnnouncement { id: string; title: string; body: string; severity: string; startsAt: string; endsAt: string }

export function PlatformAnnouncementsPage() {
  const t = useTranslations("pages.platformAnnouncements");
  const c = useTranslations("crud");
  const tt = useTable();
  const list = useList<PAnnouncement>("announcements");
  const { run, message } = useAct(list.reload);
  const [form, setForm] = React.useState(false);
  const fields: Field[] = [
    { name: "title", label: t("titleField"), required: true },
    { name: "body", label: t("bodyField"), type: "textarea", required: true },
    { name: "severity", label: t("severity"), type: "select", options: [{ value: "info", label: t("sev_info") }, { value: "warning", label: t("sev_warning") }] },
    { name: "startsAt", label: t("startsAt"), type: "datetime-local", required: true },
    { name: "endsAt", label: t("endsAt"), type: "datetime-local", required: true },
  ];
  const columns: Column<PAnnouncement>[] = [
    { key: "title", header: t("titleField"), cell: (r) => r.title },
    { key: "body", header: t("bodyField"), cell: (r) => r.body },
    { key: "severity", header: t("severity"), cell: (r) => t(`sev_${r.severity}`) },
    { key: "period", header: t("period"), cell: (r) => `${when(r.startsAt)} → ${when(r.endsAt)}` },
    { key: "actions", header: "", cell: (r) => <PermButton perm={PERMS.platformAnnouncementEdit} size="sm" variant="outline" onClick={() => window.confirm(c("confirmDelete", { name: r.title })) && void run(() => bff(`announcements/${r.id}`, { method: "DELETE" }), c("done"))}>{c("delete")}</PermButton> },
  ];
  return (
    <section>
      <H2>{t("title")}</H2>
      <Err error={list.error} />
      {message}
      <div className="mb-3 text-sm"><Can perm={PERMS.platformAnnouncementEdit}>{!form ? <IconButton icon={Plus} label={c("add")} onClick={() => setForm(true)}/> : null}</Can></div>
      {form ? (
        <FormPanel
          title={c("add")}
          fields={fields}
          initial={{ severity: "info", startsAt: new Date().toISOString().slice(0, 16), endsAt: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 16) }}
          submitLabel={t("publish")}
          cancelLabel={c("cancel")}
          onCancel={() => setForm(false)}
          onSubmit={async (p) => {
            const body = { ...p, startsAt: new Date(String(p.startsAt)).toISOString(), endsAt: new Date(String(p.endsAt)).toISOString() };
            if (await run(() => bff("announcements", { method: "POST", body }), c("done"))) setForm(false);
          }}
        />
      ) : null}
      <DataTable columns={columns} rows={list.rows} rowKey={(r) => r.id} loading={list.loading} emptyText={tt.empty} loadingText={tt.loading} labels={tt.labels} />
    </section>
  );
}
