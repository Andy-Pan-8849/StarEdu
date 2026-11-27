"use client";

// 班级的"课件"页签：列表（名称、说明、附件、操作），新建/编辑在弹窗里，详情只读。附件先登记拿预签名地址、浏览器直传对象存储，保存时再挂到课件上。
import { useTranslations } from "next-intl";
import * as React from "react";
import { Eye, Paperclip, Pencil, Plus, Trash2, X } from "lucide-react";
import { PERMS } from "@staredu/shared";
import { Button } from "@/components/ui/button";
import { bff } from "@/lib/bff";
import { Can } from "../permissions";
import { IconButton, PermRowAction, RowAction } from "../icon-button";
import { DataTable, type Column } from "../data-table";
import { Modal } from "../modal";
import { useAct } from "./crud";
import { useList } from "./use-api";
import { useTable } from "./use-table";

export const MAX_MATERIAL_FILES = 10;
export interface MaterialFile { id: string; fileName: string; size: number; downloadUrl: string }
export interface Material { id: string; title: string; description: string; url: string | null; category: string; published: boolean; files: MaterialFile[] }

const input = "rounded-md border border-border bg-transparent px-2 py-1";
export const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(n / 1024))} KB`);

export function Files({ files }: { files: MaterialFile[] }) {
  if (files.length === 0) return <span className="text-muted">—</span>;
  return (
    <ul className="space-y-0.5">
      {files.map((f) => (
        <li key={f.id} className="flex items-center gap-1"><Paperclip aria-hidden className="h-3 w-3 shrink-0 text-muted" /><a className="text-primary underline" href={f.downloadUrl} rel="noopener noreferrer">{f.fileName}</a><span className="text-muted">({kb(f.size)})</span></li>
      ))}
    </ul>
  );
}

/** 新建 / 编辑 / 只读详情（mode="view"）。 */
function MaterialDialog({ sectionId, material, mode, onClose, onSaved }: { sectionId: string; material: Material | null; mode: "create" | "edit" | "view"; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("pages.materials");
  const c = useTranslations("crud");
  const { run } = useAct(onSaved);
  const [title, setTitle] = React.useState(material?.title ?? "");
  const [description, setDescription] = React.useState(material?.description ?? "");
  const [url, setUrl] = React.useState(material?.url ?? "");
  const [published, setPublished] = React.useState(material?.published ?? false);
  const [kept, setKept] = React.useState<MaterialFile[]>(material?.files ?? []);
  const [added, setAdded] = React.useState<File[]>([]);
  const [busy, setBusy] = React.useState(false);

  if (mode === "view" && material) {
    return (
      <Modal title={material.title} onClose={onClose} closeLabel={c("close")}>
        <dl className="flex flex-col gap-3 text-sm">
          <div><dt className="text-muted">{t("status")}</dt><dd>{material.published ? t("published") : t("draft")}</dd></div>
          <div><dt className="text-muted">{t("url")}</dt><dd>{material.url ? <a className="text-primary underline" href={material.url} target="_blank" rel="noopener noreferrer">{material.url}</a> : "—"}</dd></div>
          <div><dt className="text-muted">{t("description")}</dt><dd className="whitespace-pre-wrap">{material.description || "—"}</dd></div>
          <div><dt className="text-muted">{t("files")}</dt><dd><Files files={material.files} /></dd></div>
        </dl>
        <div className="mt-4"><Button size="sm" variant="outline" onClick={onClose}>{c("close")}</Button></div>
      </Modal>
    );
  }

  const total = kept.length + added.length;
  async function save() {
    setBusy(true);
    const ok = await run(async () => {
      const ids = kept.map((f) => f.id);
      for (const f of added) {
        const up = await bff<{ fileId: string; uploadUrl: string; headers: Record<string, string> }>(`sections/${sectionId}/materials/uploads`, { method: "POST", body: { fileName: f.name, contentType: f.type || "application/octet-stream", size: f.size } });
        const put = await fetch(up.uploadUrl, { method: "PUT", headers: up.headers, body: f });
        if (!put.ok) throw new Error(t("uploadFailed", { name: f.name }));
        ids.push(up.fileId);
      }
      const body = { title, description, url: url.trim() || null, published, fileIds: ids };
      await bff(material ? `sections/${sectionId}/materials/${material.id}` : `sections/${sectionId}/materials`, { method: material ? "PATCH" : "POST", body });
    }, c("saved"));
    setBusy(false);
    if (ok) onClose();
  }
  return (
    <Modal title={material ? t("editTitle") : t("addTitle")} onClose={onClose} closeLabel={c("close")}>
      <form className="flex flex-col gap-3 text-sm" aria-label={material ? t("editTitle") : t("addTitle")} onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="flex flex-col gap-1">{t("name")}<input required className={input} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="flex flex-col gap-1">{t("description")}<textarea rows={8} className={input} value={description} maxLength={20000} onChange={(e) => setDescription(e.target.value)} /></label>
        <label className="flex flex-col gap-1">{t("url")}<input type="url" className={input} value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} /></label>
        <div className="flex flex-col gap-1">
          <span>{t("files")}</span>
          <ul className="space-y-1">
            {kept.map((f) => (
              <li key={f.id} className="flex items-center gap-2"><Paperclip aria-hidden className="h-3 w-3 text-muted" />{f.fileName} <span className="text-muted">({kb(f.size)})</span>
                <button type="button" aria-label={t("removeFile", { name: f.fileName })} className="text-muted hover:text-red-600" onClick={() => setKept(kept.filter((x) => x.id !== f.id))}><X aria-hidden className="h-3.5 w-3.5" /></button></li>
            ))}
            {added.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center gap-2"><Paperclip aria-hidden className="h-3 w-3 text-muted" />{f.name} <span className="text-muted">({kb(f.size)})</span>
                <button type="button" aria-label={t("removeFile", { name: f.name })} className="text-muted hover:text-red-600" onClick={() => setAdded(added.filter((x) => x !== f))}><X aria-hidden className="h-3.5 w-3.5" /></button></li>
            ))}
          </ul>
          {total < MAX_MATERIAL_FILES ? (
            <input type="file" multiple aria-label={t("addFiles")} onChange={(e) => { setAdded([...added, ...[...(e.target.files ?? [])].slice(0, MAX_MATERIAL_FILES - total)]); e.target.value = ""; }} />
          ) : null}
          <span className="text-xs text-muted">{t("filesHint", { n: MAX_MATERIAL_FILES })}</span>
        </div>
        <label className="flex flex-wrap items-center gap-x-2"><input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} />{t("published")}<span className="basis-full text-xs text-muted">{t("publishedHint")}</span></label>
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={busy || !title.trim()}>{c("save")}</Button>
          <Button type="button" size="sm" variant="outline" onClick={onClose}>{c("cancel")}</Button>
        </div>
      </form>
    </Modal>
  );
}

export function MaterialsPanel({ sectionId, onChanged }: { sectionId: string; onChanged?: () => void }) {
  const t = useTranslations("pages.materials");
  const c = useTranslations("crud");
  const tbl = useTable();
  const list = useList<Material>(`sections/${sectionId}/materials`);
  const reload = React.useCallback(() => { list.reload(); onChanged?.(); }, [list, onChanged]);
  const { run, message } = useAct(reload);
  const [dialog, setDialog] = React.useState<{ mode: "create" | "edit" | "view"; row: Material | null } | null>(null);
  const columns: Column<Material>[] = [
    { key: "title", header: t("name"), cell: (m) => (m.url ? <a className="font-medium text-primary underline" href={m.url} target="_blank" rel="noopener noreferrer">{m.title}</a> : <span className="font-medium">{m.title}</span>) },
    { key: "description", header: t("description"), cell: (m) => <span className="line-clamp-2 max-w-xs whitespace-pre-line">{m.description || "—"}</span> },
    { key: "files", header: t("files"), cell: (m) => <Files files={m.files} /> },
    { key: "status", header: t("status"), cell: (m) => (m.published ? t("published") : <span className="text-muted">{t("draft")}</span>) },
    {
      key: "actions",
      header: "",
      cell: (m) => (
        <div className="flex flex-wrap gap-1">
          <RowAction icon={Eye} onClick={() => setDialog({ mode: "view", row: m })}>{t("detail")}</RowAction>
          <PermRowAction perm={PERMS.eduMaterialEdit} icon={Pencil} onClick={() => setDialog({ mode: "edit", row: m })}>{c("edit")}</PermRowAction>
          <PermRowAction perm={PERMS.eduMaterialEdit} icon={Trash2} danger onClick={() => window.confirm(c("confirmDelete", { name: m.title })) && void run(() => bff(`sections/${sectionId}/materials/${m.id}`, { method: "DELETE" }), c("done"))}>{c("delete")}</PermRowAction>
        </div>
      ),
    },
  ];
  return (
    <div>
      {message}
      <Can perm={PERMS.eduMaterialEdit}>
        <div className="mb-2"><IconButton icon={Plus} label={c("add")} onClick={() => setDialog({ mode: "create", row: null })} /></div>
      </Can>
      <DataTable columns={columns} rows={list.rows} rowKey={(m) => m.id} loading={list.loading} emptyText={t("empty")} loadingText={tbl.loading} selectable={false} labels={tbl.labels} />
      {dialog ? <MaterialDialog key={dialog.row?.id ?? "new"} sectionId={sectionId} material={dialog.row} mode={dialog.mode} onClose={() => setDialog(null)} onSaved={reload} /> : null}
    </div>
  );
}

/** 学生看自己班级里已发布的课件（说明、链接、附件下载）；没选这个班时接口返回 404，这里什么都不显示。 */
export function StudentMaterials({ sectionId }: { sectionId: string }) {
  const t = useTranslations("pages.materials");
  const [rows, setRows] = React.useState<Material[] | null>(null);
  React.useEffect(() => { void bff<Material[]>(`sections/${sectionId}/materials`).then(setRows).catch(() => setRows(null)); }, [sectionId]);
  if (rows === null) return null;
  return (
    <div>
      <h3 className="mb-1 font-medium">{t("studentTitle")}</h3>
      {rows.length === 0 ? <p className="text-muted">{t("studentEmpty")}</p> : (
        <ul className="space-y-2">
          {rows.map((m) => (
            <li key={m.id} className="rounded-md border border-border p-2">
              <div className="font-medium">{m.url ? <a className="text-primary underline" href={m.url} target="_blank" rel="noopener noreferrer">{m.title}</a> : m.title}</div>
              {m.description ? <p className="whitespace-pre-wrap text-muted">{m.description}</p> : null}
              {m.files.length ? <div className="mt-1"><Files files={m.files} /></div> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
