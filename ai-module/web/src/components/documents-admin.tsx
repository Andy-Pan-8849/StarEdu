"use client";

/**
 * 文件：components/documents-admin.tsx
 * 作用：文档管理页（仅 RAGETLAdmin）：文档列表、搜索与筛选、上传、编辑权限、查看入库任务、
 *   重新入库、删除。
 * 主要思想：
 *   - DocumentsAdmin 先检查角色，没有权限显示提示（这只是方便，API 会再校验）；有权限才渲染
 *     Manager。
 *   - Manager 的列表可按标题/编号搜索，按领域、状态、入库状态筛选，游标分页（Load more）。
 *   - 入库是后台异步的：只要有文档处于 queued 或 running，每 3 秒自动刷新一次，直到都结束，
 *     所以上传后能看到状态 queued -> running -> ready。
 *   - 各种操作的对话框在 document-dialogs.tsx，上传表单在 upload-form.tsx。
 */

import { useCallback, useEffect, useState } from "react";
import { useAuth, useMe } from "@/components/auth-provider";
import { DeleteDialog, EditDialog, JobsDialog } from "@/components/document-dialogs";
import { Badge, Button, Input, Select } from "@/components/ui";
import { UploadForm } from "@/components/upload-form";
import { canManageDocuments } from "@/lib/auth";
import { userMessage } from "@/lib/api";
import { DOMAINS, type DocumentMeta, type Page } from "@/lib/types";
import { formatTime } from "@/lib/utils";

// 入库进行中时的刷新间隔（毫秒）
const POLL_MS = 3000;

// 入库状态 -> 徽标颜色
const INGEST_TONE = { queued: "gray", running: "blue", ready: "green", failed: "red" } as const;

/**
 * 入口：没有文档管理角色就显示无权限提示，否则显示管理界面。
 */
export function DocumentsAdmin() {
  const me = useMe();
  if (!canManageDocuments(me.roles)) {
    return (
      <div className="p-8 text-sm" role="alert">
        You do not have permission to manage documents.
      </div>
    );
  }
  return <Manager />;
}

/**
 * 管理界面本体：状态、列表、筛选、上传和各对话框的开关都在这里。
 */
function Manager() {
  const { api } = useAuth();
  const [items, setItems] = useState<DocumentMeta[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [domain, setDomain] = useState("");
  const [status, setStatus] = useState("");
  const [ingest, setIngest] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<DocumentMeta | null>(null);
  const [jobsFor, setJobsFor] = useState<DocumentMeta | null>(null);
  const [deleting, setDeleting] = useState<DocumentMeta | null>(null);

  // 把当前搜索/筛选条件拼成 /documents 的请求地址（cursor 用于翻页）
  const query = useCallback(
    (cursor?: string) => {
      const params = new URLSearchParams({ limit: "50" });
      if (q.trim()) params.set("q", q.trim());
      if (domain) params.set("domain", domain);
      if (status) params.set("status", status);
      if (ingest) params.set("ingest_status", ingest);
      if (cursor) params.set("cursor", cursor);
      return `/documents?${params.toString()}`;
    },
    [q, domain, status, ingest],
  );

  // 重新取第一页并替换列表
  const refresh = useCallback(async () => {
    try {
      const page = await api.json<Page<DocumentMeta>>(query());
      setItems(page.items);
      setNext(page.next_cursor);
      setError(null);
    } catch (e) {
      setError(userMessage(e));
    }
  }, [api, query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 有文档还在排队或入库：开启定时刷新，全部结束后自动停止
  const working = items.some((d) => d.ingest_status === "queued" || d.ingest_status === "running");
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [working, refresh]);

  /**
   * 加载下一页并追加到列表末尾。
   */
  async function more() {
    if (!next) return;
    try {
      const page = await api.json<Page<DocumentMeta>>(query(next));
      setItems((current) => [...current, ...page.items]);
      setNext(page.next_cursor);
    } catch (e) {
      setError(userMessage(e));
    }
  }

  /**
   * 让这份文档重新排入入库队列（比如换了嵌入模型之后）。
   */
  async function reindex(document: DocumentMeta) {
    try {
      await api.json(`/documents/${document.id}/reindex`, { method: "POST" });
      setNotice(`${document.doc_code} is queued for ingestion again.`);
      await refresh();
    } catch (e) {
      setError(userMessage(e));
    }
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-slate-900">Documents</h1>
          <Button onClick={() => setShowUpload((v) => !v)}>
            {showUpload ? "Close" : "Upload a document"}
          </Button>
        </div>

        {showUpload ? (
          <section className="rounded-lg border border-slate-200 bg-white p-4">
            <UploadForm
              onUploaded={(d) => {
                setNotice(`${d.doc_code} v${d.version} was uploaded and is being processed.`);
                setShowUpload(false);
                void refresh();
              }}
            />
          </section>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Input
            aria-label="Search title or code"
            placeholder="Search title or code"
            className="max-w-xs"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Select
            aria-label="Filter by domain"
            className="w-40"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          >
            <option value="">All domains</option>
            {DOMAINS.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </Select>
          <Select
            aria-label="Filter by status"
            className="w-40"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">Any status</option>
            <option>active</option>
            <option>superseded</option>
            <option>draft</option>
          </Select>
          <Select
            aria-label="Filter by ingestion"
            className="w-44"
            value={ingest}
            onChange={(e) => setIngest(e.target.value)}
          >
            <option value="">Any ingestion state</option>
            <option>queued</option>
            <option>running</option>
            <option>ready</option>
            <option>failed</option>
          </Select>
        </div>

        {notice ? (
          <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">Code</th>
                <th>Title</th>
                <th>Version</th>
                <th>Domain</th>
                <th>Status</th>
                <th>Ingestion</th>
                <th>Updated</th>
                <th className="pr-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-mono text-xs">{d.doc_code}</td>
                  <td className="max-w-xs truncate">{d.title}</td>
                  <td>{d.version}</td>
                  <td>{d.domain}</td>
                  <td>
                    <Badge tone={d.status === "active" ? "green" : "amber"}>{d.status}</Badge>
                  </td>
                  <td>
                    <Badge tone={INGEST_TONE[d.ingest_status]}>{d.ingest_status}</Badge>
                  </td>
                  <td className="text-xs text-slate-500">{formatTime(d.updated_at)}</td>
                  <td className="space-x-1 whitespace-nowrap pr-3 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(d)}
                      aria-label={`Edit ${d.doc_code}`}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setJobsFor(d)}
                      aria-label={`Ingestion of ${d.doc_code}`}
                    >
                      Jobs
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void reindex(d)}
                      aria-label={`Reindex ${d.doc_code}`}
                    >
                      Reindex
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setDeleting(d)}
                      aria-label={`Delete ${d.doc_code}`}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
              {items.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-slate-500">
                    No documents match.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {next ? (
          <Button variant="secondary" onClick={() => void more()}>
            Load more
          </Button>
        ) : null}
      </div>

      {editing ? (
        <EditDialog
          document={editing}
          onClose={() => setEditing(null)}
          onSaved={() => void refresh()}
        />
      ) : null}
      {jobsFor ? <JobsDialog document={jobsFor} onClose={() => setJobsFor(null)} /> : null}
      {deleting ? (
        <DeleteDialog
          document={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => void refresh()}
        />
      ) : null}
    </div>
  );
}
