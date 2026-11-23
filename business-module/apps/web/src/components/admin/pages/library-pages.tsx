"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { PERMS } from "@staredu/shared";
import { Button } from "@/components/ui/button";
import { Copy, Download, Eye, FolderInput, FolderPlus, FolderRoot, FolderTree, Lock, Folder as FolderIcon, Pencil, Trash2, Upload } from "lucide-react";
import { IconButton, Tip } from "../icon-button";
import { DataTable, type Column } from "../data-table";
import { useFitHeight } from "../fit-height";
import { NavTree, type NavNode } from "../nav-tree";
import { Modal } from "../modal";
import { usePromptDialog } from "../prompt-dialog";
import { Can } from "../permissions";
import { bff, BffError } from "@/lib/bff";
import { useList } from "./use-api";

interface Folder { id: string; parentId: string | null; name: string; classification: "public" | "internal" | "confidential"; level: "view" | "edit" | "manage"; inheritAcl: boolean; previewOnly: boolean; logAccess: boolean; files: number }
interface LibFile { id: string; name: string; size: number; version: number; uploadedBy: string | null; uploadedAt: string; canDownload: boolean; canPreview: boolean; canEdit: boolean; canDelete: boolean }
interface Acl { id: string; principalType: string; principalName: string | null; includeSub: boolean; level: string; source: string; expiresAt: string | null; expired: boolean }
interface LogRow { id: string; at: string; action: string; username: string | null; fileName: string | null }
interface Preview { url: string; name: string; contentType: string; viewOnly: boolean; watermark: string | null }
const input = "rounded-md border border-border bg-transparent px-2 py-1";

/** 文件夹按父子关系排成带缩进的列表（看不到的父级，子文件夹就当作顶层）。 */
export function flatten(rows: Folder[]): Array<Folder & { depth: number }> {
  const byParent = new Map<string | null, Folder[]>();
  for (const f of rows) byParent.set(f.parentId, [...(byParent.get(f.parentId) ?? []), f]);
  const out: Array<Folder & { depth: number }> = [];
  const walk = (parent: string | null, depth: number) => {
    for (const f of byParent.get(parent) ?? []) {
      out.push({ ...f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** 文件夹按父子关系嵌套成树（看不到的父级，子文件夹就当作顶层）。 */
export function nest(rows: Folder[]): NavNode[] {
  const byParent = new Map<string | null, Folder[]>();
  for (const f of rows) byParent.set(f.parentId, [...(byParent.get(f.parentId) ?? []), f]);
  const build = (parent: string | null): NavNode[] =>
    (byParent.get(parent) ?? []).map((f) => ({
      id: f.id,
      label: f.name,
      icon: f.classification === "confidential" ? <Lock aria-hidden className="h-4 w-4" /> : <FolderIcon aria-hidden className="h-4 w-4" />,
      children: build(f.id),
    }));
  return build(null);
}

const fmtSize = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/** 在线查看：预览内容上叠一层水印（查看者姓名和时间）。水印只是威慑，真正的兜底是访问日志。 */
function Viewer({ p, onClose }: { p: Preview; onClose: () => void }) {
  const t = useTranslations("pages.library");
  const text = p.watermark ? Array.from({ length: 30 }, () => p.watermark).join("      ") : null;
  return (
    <div role="dialog" aria-label={p.name} className="fixed inset-0 z-50 flex flex-col bg-black/70 p-4">
      <div className="mb-2 flex items-center justify-between text-white">
        <span>{p.name}{p.viewOnly ? ` · ${t("viewOnly")}` : ""}</span>
        <Button size="sm" variant="outline" onClick={onClose}>{t("close")}</Button>
      </div>
      <div className="relative flex-1 overflow-hidden rounded bg-white" onContextMenu={p.viewOnly ? (e) => e.preventDefault() : undefined}>
        {p.contentType.startsWith("image/") ? <img src={p.url} alt={p.name} className="mx-auto max-h-full" /> : <iframe title={p.name} src={p.url} className="h-full w-full" />}
        {text ? (
          <div aria-hidden className="pointer-events-none absolute inset-0 select-none overflow-hidden text-sm text-black/15" style={{ transform: "rotate(-25deg) scale(1.6)", lineHeight: "5rem", whiteSpace: "pre-wrap" }}>
            {Array.from({ length: 14 }, () => text).join("\n")}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function GrantForm({ folder, base, run, reload }: { folder: Folder; base: string; run: (fn: () => Promise<unknown>, after?: () => void) => Promise<void>; reload: () => void }) {
  const t = useTranslations("pages.library");
  const [grant, setGrant] = React.useState({ principalType: "dept", principalId: "", level: "view", includeSub: true, expiresAt: "" });
  const [principals, setPrincipals] = React.useState<Array<{ id: string; label: string }>>([]);
  const named = grant.principalType === "everyone" || grant.principalType === "all_staff";
  React.useEffect(() => {
    if (!named) void bff<Array<{ id: string; label: string }>>(`library/principals?type=${grant.principalType}`).then(setPrincipals).catch(() => setPrincipals([]));
  }, [grant.principalType, named]);
  return (
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => bff(`${base}/acl`, { method: "POST", body: { principalType: grant.principalType, principalId: named ? null : grant.principalId, includeSub: grant.principalType === "dept" ? grant.includeSub : undefined, level: grant.level, expiresAt: grant.expiresAt ? new Date(`${grant.expiresAt}T23:59:59`).toISOString() : null } }), () => reload()); }}>
            <select aria-label={t("who")} className={input} value={grant.principalType} onChange={(e) => setGrant({ ...grant, principalType: e.target.value, principalId: "" })}>
              {["dept", "role", "user", ...(folder.classification === "confidential" ? [] : ["all_staff", "everyone"])].map((p) => <option key={p} value={p}>{t(`pt_${p}`)}</option>)}
            </select>
            {!named ? (
              <select aria-label={t("pick")} className={input} value={grant.principalId} onChange={(e) => setGrant({ ...grant, principalId: e.target.value })}>
                <option value="">{t("pick")}</option>
                {principals.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            ) : null}
            {grant.principalType === "dept" ? <label className="flex items-center gap-1"><input type="checkbox" checked={grant.includeSub} onChange={(e) => setGrant({ ...grant, includeSub: e.target.checked })} />{t("includeSub")}</label> : null}
            <select aria-label={t("level")} className={input} value={grant.level} onChange={(e) => setGrant({ ...grant, level: e.target.value })}>
              {["view", "edit", "manage"].map((l) => <option key={l} value={l}>{t(`lv_${l}`)}</option>)}
            </select>
            <input aria-label={t("until")} type="date" className={input} value={grant.expiresAt} onChange={(e) => setGrant({ ...grant, expiresAt: e.target.value })} />
            <Button type="submit" size="sm" disabled={!named && !grant.principalId}>{t("grant")}</Button>
          </form>
  );
}

/** 文件夹管理：基本信息 / 访问授权 / 访问日志。 */
function FolderManager({ folder, onChanged, onClose }: { folder: Folder; onChanged: () => void; onClose: () => void }) {
  const t = useTranslations("pages.library");
  const [tab, setTab] = React.useState<"info" | "acl" | "log">("info");
  const [name, setName] = React.useState(folder.name);
  const [classification, setClassification] = React.useState(folder.classification);
  const [inherit, setInherit] = React.useState(folder.inheritAcl);
  const [previewOnly, setPreviewOnly] = React.useState(folder.previewOnly);
  const [err, setErr] = React.useState<string | null>(null);
  const [items, setItems] = React.useState<Acl[]>([]);
  const [log, setLog] = React.useState<LogRow[]>([]);
  const base = `library/folders/${folder.id}`;
  const loadAcl = React.useCallback(() => bff<{ items: Acl[] }>(`${base}/acl`).then((r) => setItems(r.items)).catch((e: Error) => setErr(e.message)), [base]);
  React.useEffect(() => {
    if (tab === "acl") void loadAcl();
    if (tab === "log") void bff<LogRow[]>(`${base}/log`).then(setLog).catch((e: Error) => setErr(e.message));
  }, [tab, base, loadAcl]);

  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    try { setErr(null); await fn(); after?.(); } catch (e) { setErr((e as Error).message); }
  };
  const save = async (confirm = false) => {
    try {
      setErr(null);
      await bff(base, { method: "PATCH", body: { name, classification, inheritAcl: inherit, previewOnly, confirm } });
      onChanged();
    } catch (e) {
      if (e instanceof BffError && e.status === 409 && !confirm && window.confirm(`${e.message}\n${t("confirmContinue")}`)) return save(true);
      setErr((e as Error).message);
    }
  };
  return (
    <Modal wide title={folder.name} onClose={onClose}>
    <div className="text-sm">
      {err ? <p role="alert" className="mb-2 text-red-600">{err}</p> : null}
      <div className="mb-2 flex gap-2">
        {(["info", "acl", "log"] as const).map((k) => (
          <Can key={k} perm={k === "info" ? PERMS.docFolderEdit : k === "acl" ? PERMS.docAclEdit : PERMS.docLogList}>
            <Button size="sm" variant={tab === k ? "default" : "outline"} onClick={() => setTab(k)}>{t(`tab_${k}`)}</Button>
          </Can>
        ))}
      </div>
      {tab === "info" ? (
        <div className="flex flex-col gap-2">
          <input aria-label={t("name")} className={input} value={name} onChange={(e) => setName(e.target.value)} />
          <select aria-label={t("classification")} className={input} value={classification} onChange={(e) => setClassification(e.target.value as Folder["classification"])}>
            {(["public", "internal", "confidential"] as const).map((c) => <option key={c} value={c}>{t(`class_${c}`)}</option>)}
          </select>
          {classification !== "confidential" ? (
            <label className="flex items-center gap-2"><input type="checkbox" checked={inherit} onChange={(e) => setInherit(e.target.checked)} />{t("inherit")}</label>
          ) : (
            <>
              <p className="text-muted">{t("confidentialRules")}</p>
              <label className="flex items-center gap-2"><input type="checkbox" checked={previewOnly} onChange={(e) => setPreviewOnly(e.target.checked)} />{t("previewOnly")}</label>
            </>
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void save()}>{t("save")}</Button>
            <Can perm={PERMS.docFolderRemove}>
              <Button size="sm" variant="outline" disabled={folder.level !== "manage"} onClick={() => window.confirm(t("confirmDeleteFolder")) && void run(() => bff(base, { method: "DELETE" }), onChanged)}>{t("deleteFolder")}</Button>
            </Can>
          </div>
        </div>
      ) : null}
      {tab === "acl" ? (
        <div>
          <table className="mb-3 w-full">
            <thead><tr className="text-left text-muted"><th>{t("who")}</th><th>{t("level")}</th><th>{t("until")}</th><th /></tr></thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id} className={a.expired ? "opacity-50" : ""}>
                  <td>{t(`pt_${a.principalType}`)}{a.principalName && !["everyone", "all_staff"].includes(a.principalType) ? `: ${a.principalName}` : ""}{a.includeSub ? ` (${t("includeSub")})` : ""}</td>
                  <td>{t(`lv_${a.level}`)}</td>
                  <td>{a.expiresAt ? new Date(a.expiresAt).toLocaleDateString() : "—"}{a.expired ? ` (${t("expired")})` : ""}</td>
                  <td><button type="button" className="underline" onClick={() => void run(() => bff(`${base}/acl/${a.id}`, { method: "DELETE" }), () => void loadAcl())}>{t("remove")}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <GrantForm folder={folder} base={base} run={run} reload={() => void loadAcl()} />
        </div>
      ) : null}
      {tab === "log" ? (
        <table className="w-full">
          <thead><tr className="text-left text-muted"><th>{t("time")}</th><th>{t("user")}</th><th>{t("action")}</th><th>{t("file")}</th></tr></thead>
          <tbody>{log.map((l) => <tr key={l.id}><td>{new Date(l.at).toLocaleString()}</td><td>{l.username}</td><td>{l.action}</td><td>{l.fileName}</td></tr>)}</tbody>
        </table>
      ) : null}
    </div>
    </Modal>
  );
}

/** 文档库：左边文件夹树，右边文件列表。管理后台和门户共用；按钮显示看服务端给的级别和 canXxx。 */
export function LibraryPanel({ portal = false }: { portal?: boolean }) {
  const t = useTranslations("pages.library");
  const folders = useList<Folder>("library/folders");
  const [cur, setCur] = React.useState<string | null>(null);
  const [files, setFiles] = React.useState<LibFile[]>([]);
  const [viewer, setViewer] = React.useState<Preview | null>(null);
  const [managing, setManaging] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const { ask, dialog } = usePromptDialog();
  const tree = React.useMemo(() => flatten(folders.rows), [folders.rows]);
  const folder = folders.rows.find((f) => f.id === cur) ?? null;
  const loadFiles = React.useCallback((id: string) => bff<LibFile[]>(`library/folders/${id}/files`).then(setFiles).catch((e: Error) => setMsg(e.message)), []);
  React.useEffect(() => { if (cur) void loadFiles(cur); else setFiles([]); }, [cur, loadFiles]);

  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    try { setMsg(null); await fn(); after?.(); } catch (e) { setMsg((e as Error).message); }
  };
  const upload = async (list: FileList | null, replace?: string) => {
    if (!cur || !list) return;
    for (const f of Array.from(list)) {
      await run(async () => {
        const up = await bff<{ uploadId: string; uploadUrl: string; headers: Record<string, string> }>(`library/folders/${cur}/uploads`, { method: "POST", body: { name: f.name, size: f.size, contentType: f.type || "application/octet-stream", fileId: replace } });
        const put = await fetch(up.uploadUrl, { method: "PUT", headers: up.headers, body: f });
        if (!put.ok) throw new Error(t("uploadFailed", { name: f.name }));
        await bff(`library/folders/${cur}/uploads/confirm`, { method: "POST", body: { uploadId: up.uploadId } });
      });
    }
    void loadFiles(cur);
    folders.reload();
  };
  const open = (path: string) => run(async () => { const r = await bff<{ url: string }>(path); window.open(r.url, "_blank", "noopener"); });
  const pickTarget = async (title: string): Promise<string | null> => {
    const options = tree.filter((f) => f.id !== cur && ["edit", "manage"].includes(f.level)).map((f) => ({ value: f.id, label: `${"— ".repeat(f.depth)}${f.name}` }));
    const v = await ask(title, [{ name: "target", label: t("targetPrompt"), type: "select", options }]);
    return v?.target || null;
  };
  const moveOrCopy = async (f: LibFile, kind: "move" | "copy") => {
    const targetId = await pickTarget(f.name);
    if (!targetId) return;
    try {
      await bff(`library/files/${f.id}/${kind}`, { method: "POST", body: { targetId } });
    } catch (e) {
      if (e instanceof BffError && e.status === 409 && kind === "move" && window.confirm(`${e.message}\n${t("confirmContinue")}`)) await bff(`library/files/${f.id}/move`, { method: "POST", body: { targetId, confirm: true } });
      else { setMsg((e as Error).message); return; }
    }
    void loadFiles(cur as string);
    folders.reload();
  };
  const createFolder = (parentId: string | null, name: string) => run(() => bff("library/folders", { method: "POST", body: { name, parentId } }), () => { folders.reload(); });

  const tt = useTranslations("table");
  const tableLabels = { actions: tt("actions"), selectAll: tt("selectAll"), selectRow: tt("selectRow"), clearSelection: tt("clearSelection"), selected: (n: number) => tt("selected", { n }), previous: tt("previous"), next: tt("next"), page: (p: number, n: number) => tt("page", { page: p, pages: n }) };
  const nodes = React.useMemo(() => nest(folders.rows), [folders.rows]);
  // 默认选中第一个文件夹；当前文件夹没了（删除、权限变化）就回到第一个
  React.useEffect(() => {
    if (tree.length > 0 && (cur === null || !folders.rows.some((f) => f.id === cur))) setCur(tree[0]!.id);
  }, [tree, cur, folders.rows]);
  const { ref: treeRef, maxHeight: treeMax } = useFitHeight<HTMLDivElement>();
  const columns: Column<LibFile>[] = [
    { key: "name", header: t("file"), cell: (f) => f.name },
    { key: "size", header: t("size"), cell: (f) => fmtSize(f.size) },
    { key: "version", header: t("version"), cell: (f) => `v${f.version}` },
    { key: "by", header: t("uploadedBy"), cell: (f) => f.uploadedBy ?? "" },
    {
      key: "actions",
      header: "",
      cell: (f) => (
        <>
          {f.canPreview ? <IconButton icon={Eye} label={t("preview")} variant="outline" onClick={() => void run(async () => setViewer(await bff<Preview>(`library/files/${f.id}/preview`)))} /> : null}
          {f.canDownload ? <IconButton icon={Download} label={t("download")} variant="outline" onClick={() => void open(`library/files/${f.id}/download`)} /> : null}
          {!portal && f.canEdit ? (
            <>
              <IconButton icon={Pencil} label={t("rename")} variant="outline" onClick={() => void ask(t("rename"), [{ name: "name", label: t("rename"), initial: f.name }]).then((v) => { if (v) void run(() => bff(`library/files/${f.id}`, { method: "PATCH", body: { name: v.name } }), () => void loadFiles(cur as string)); })} />
              <Tip label={t("newVersion")}>
                <label className="inline-flex h-8 cursor-pointer items-center rounded-md border border-border px-2 hover:bg-border/40"><Upload aria-hidden className="h-4 w-4" /><span className="sr-only">{t("newVersion")}</span><input type="file" className="hidden" onChange={(e) => { void upload(e.target.files, f.id); e.target.value = ""; }} /></label>
              </Tip>
              <IconButton icon={FolderInput} label={t("move")} variant="outline" onClick={() => void moveOrCopy(f, "move")} />
            </>
          ) : null}
          {!portal && f.canDownload ? <IconButton icon={Copy} label={t("copy")} variant="outline" onClick={() => void moveOrCopy(f, "copy")} /> : null}
          {!portal && f.canDelete ? <IconButton icon={Trash2} label={t("delete")} variant="outline" onClick={() => window.confirm(t("confirmDeleteFile")) && void run(() => bff(`library/files/${f.id}`, { method: "DELETE" }), () => { void loadFiles(cur as string); folders.reload(); })} /> : null}
        </>
      ),
    },
  ];
  const canUpload = !portal && folder !== null && ["edit", "manage"].includes(folder.level);
  const deleteMany = async (ids: string[]) => {
    if (!window.confirm(t("confirmDeleteMany", { n: ids.length }))) return;
    await run(async () => { for (const id of ids) await bff(`library/files/${id}`, { method: "DELETE" }); }, () => { void loadFiles(cur as string); folders.reload(); });
  };

  return (
    <section className="text-sm">
      <h2 className="mb-3 text-lg font-semibold">{t("title")}</h2>
      {msg ? <p role="alert" className="mb-2 text-red-600">{msg}</p> : null}
      {dialog}
      <div className="flex gap-4">
        <aside className="w-72 shrink-0 overflow-hidden rounded-md border border-border">
          <div className="border-b border-border bg-slate-100 px-3 py-2 dark:bg-slate-800">
            <span className="flex items-center gap-2 font-medium"><FolderTree aria-hidden className="h-4 w-4 text-muted" />{t("folders")}</span>
            {!portal ? (
              <div className="mt-2 flex flex-wrap gap-1">
                <Can perm={PERMS.docFolderAdd}>
                  <IconButton icon={FolderPlus} label={t("addSub")} variant="outline" disabled={!folder || folder.level !== "manage"} onClick={() => void ask(t("addSub"), [{ name: "name", label: t("newFolder") }]).then((v) => { if (v?.name.trim()) void createFolder(cur, v.name.trim()); })} />
                  <IconButton icon={FolderRoot} label={t("add")} variant="outline" onClick={() => void ask(t("add"), [{ name: "name", label: t("newFolder") }]).then((v) => { if (v?.name.trim()) void createFolder(null, v.name.trim()); })} />
                </Can>
                {folder ? (
                  <>
                    <Can perm={PERMS.docFolderEdit}>
                      <IconButton icon={Pencil} label={t("edit")} variant="outline" disabled={folder.level !== "manage"} onClick={() => setManaging(true)} />
                    </Can>
                    <Can perm={PERMS.docFolderRemove}>
                      <IconButton icon={Trash2} label={t("deleteFolder")} variant="outline" disabled={folder.level !== "manage"} onClick={() => window.confirm(t("confirmDeleteFolder")) && void run(() => bff(`library/folders/${folder.id}`, { method: "DELETE" }), () => { setCur(null); folders.reload(); })} />
                    </Can>
                  </>
                ) : null}
              </div>
            ) : null}
            {!portal && folder && folder.level !== "manage" ? <p className="mt-2 text-xs text-muted">{t("needManage")}</p> : null}
          </div>
          <div ref={treeRef} className="overflow-y-auto p-2" style={treeMax ? { maxHeight: treeMax } : undefined}>
            {nodes.length === 0 ? <p className="px-2 py-3 text-muted">{t("noFolders")}</p> : <NavTree label={t("folders")} nodes={nodes} selectedId={cur} onSelect={(id) => { setCur(id); setManaging(false); }} />}
          </div>
        </aside>
        <div className="min-w-0 flex-1">
          <div className="mb-3 flex min-h-8 items-center gap-2">
            {folder ? (
              <>
                <h3 className="text-base font-semibold">{folder.name}</h3>
                <span className="text-muted">{t(`class_${folder.classification}`)}{folder.previewOnly ? ` · ${t("viewOnly")}` : ""}</span>
                <span className="ml-auto flex items-center gap-2">
                  {canUpload ? (
                    <Can perm={PERMS.docFileUpload}>
                      <Tip label={t("upload")}><label className="inline-flex h-8 cursor-pointer items-center rounded-md bg-primary px-2 text-primary-foreground hover:opacity-90"><Upload aria-hidden className="h-4 w-4" /><span className="sr-only">{t("upload")}</span><input type="file" multiple className="hidden" onChange={(e) => { void upload(e.target.files); e.target.value = ""; }} /></label></Tip>
                    </Can>
                  ) : null}
                </span>
              </>
            ) : <span className="text-muted">{t("pickFolder")}</span>}
          </div>
          {folder && managing ? <FolderManager key={folder.id} folder={folder} onClose={() => setManaging(false)} onChanged={() => { setManaging(false); folders.reload(); setCur(null); }} /> : null}
          <DataTable
            columns={columns}
            rows={folder ? files : []}
            rowKey={(f) => f.id}
            emptyText={folder ? t("empty") : t("noFolders")}
            selectable={!portal}
            labels={tableLabels}
            bulkActions={(ids) => (!portal && files.filter((f) => ids.includes(f.id)).every((f) => f.canDelete) ? <IconButton icon={Trash2} label={t("deleteSelected")} variant="outline" onClick={() => void deleteMany(ids)} /> : null)}
          />
        </div>
      </div>
      {viewer ? <Viewer p={viewer} onClose={() => setViewer(null)} /> : null}
    </section>
  );
}

export const LibraryPage = () => <LibraryPanel />;
export const PortalLibraryPage = () => <LibraryPanel portal />;
