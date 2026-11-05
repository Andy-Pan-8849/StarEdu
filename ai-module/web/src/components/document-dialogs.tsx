"use client";

/**
 * 文件：components/document-dialogs.tsx
 * 作用：文档管理页用到的三个对话框：
 *   - EditDialog 编辑：标题、状态、权限级别、校区范围、指名用户、最低职等（PATCH）；
 *   - JobsDialog 入库任务：查看这份文档每次入库的状态、阶段、重试次数、错误（GET jobs）；
 *   - DeleteDialog 删除：明确告知“文档、检索索引和原文件都会删除，不可撤销”，确认后才删除。
 * 权限修改在服务端是“文档和它的所有文本块一起变”，所以保存后立刻对检索生效。
 */

import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "@/components/auth-provider";
import { Badge, Button, Field, Input, Modal, Select } from "@/components/ui";
import { userMessage } from "@/lib/api";
import { ACCESS_LEVELS, type DocumentMeta, type Job } from "@/lib/types";
import { formatTime } from "@/lib/utils";
import { splitList } from "@/lib/validation";

/**
 * 编辑文档的元数据与权限。参数：document 要编辑的文档；onClose 关闭；onSaved 保存成功后的回调。
 */
export function EditDialog({
  document,
  onClose,
  onSaved,
}: {
  document: DocumentMeta;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { api } = useAuth();
  const [title, setTitle] = useState(document.title);
  const [status, setStatus] = useState<string>(document.status);
  const [access, setAccess] = useState(document.access_level);
  const [campuses, setCampuses] = useState(document.campus_scope.join(", "));
  const [users, setUsers] = useState(document.allowed_users.join(", "));
  const [level, setLevel] = useState(document.min_level_rank?.toString() ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * 保存：先在前端检查职等（1-7 整数）、标题非空、至少一个校区；通过后 PATCH，最低职等传 null
   *   表示去掉要求。
   */
  async function save(event: FormEvent) {
    event.preventDefault();
    const grade = level.trim() === "" ? null : Number(level);
    if (grade !== null && (!Number.isInteger(grade) || grade < 1 || grade > 7)) {
      setError("The grade must be a whole number from 1 to 7.");
      return;
    }
    if (!title.trim()) {
      setError("Enter a title.");
      return;
    }
    const scope = splitList(campuses);
    if (scope.length === 0) {
      setError("Name at least one campus, or all.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.json(`/documents/${document.id}`, {
        method: "PATCH",
        json: {
          title: title.trim(),
          status,
          access_level: access,
          campus_scope: scope,
          allowed_users: splitList(users),
          min_level: grade,
        },
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(userMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Edit ${document.doc_code} v${document.version}`} onClose={onClose}>
      <form onSubmit={save} noValidate className="grid gap-3">
        <Field label="Title">
          <Input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Status">
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option>active</option>
            <option>superseded</option>
            <option>draft</option>
          </Select>
        </Field>
        <Field label="Who may read it">
          <Select
            aria-label="Who may read it"
            value={access}
            onChange={(e) => setAccess(e.target.value)}
          >
            {ACCESS_LEVELS.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </Select>
        </Field>
        <Field label="Campuses" hint="Comma separated, or all">
          <Input
            aria-label="Campuses"
            value={campuses}
            onChange={(e) => setCampuses(e.target.value)}
          />
        </Field>
        <Field label="Minimum grade (1–7)" hint="Empty removes the requirement">
          <Input
            aria-label="Minimum grade"
            value={level}
            onChange={(e) => setLevel(e.target.value)}
          />
        </Field>
        <Field label="Also allow these users" hint="Comma separated user ids">
          <Input
            aria-label="Allowed users"
            value={users}
            onChange={(e) => setUsers(e.target.value)}
          />
        </Field>
        <p className="text-xs text-slate-500">
          Changing who may read a document changes it everywhere at once, including its search
          results.
        </p>
        {error ? (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * 显示一份文档的入库任务历史。
 */
export function JobsDialog({ document, onClose }: { document: DocumentMeta; onClose: () => void }) {
  const { api } = useAuth();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .json<{ items: Job[] }>(`/documents/${document.id}/jobs`)
      .then((r) => setJobs(r.items))
      .catch((e: unknown) => setError(userMessage(e)));
  }, [api, document.id]);

  return (
    <Modal title={`Ingestion of ${document.doc_code} v${document.version}`} onClose={onClose} wide>
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {jobs === null && !error ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {jobs?.length === 0 ? <p className="text-sm text-slate-500">No ingestion jobs yet.</p> : null}
      {jobs && jobs.length > 0 ? (
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr>
              <th className="py-1">Status</th>
              <th>Stage</th>
              <th>Attempt</th>
              <th>Started</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} className="border-t border-slate-100 align-top">
                <td className="py-1.5">
                  <Badge
                    tone={
                      j.status === "succeeded" ? "green" : j.status === "failed" ? "red" : "blue"
                    }
                  >
                    {j.status}
                  </Badge>
                </td>
                <td>{j.stage ?? "–"}</td>
                <td>
                  {j.attempt}/{j.max_attempts}
                </td>
                <td>{formatTime(j.started_at)}</td>
                <td className="max-w-xs break-words text-red-700">
                  {j.error_code ? `${j.error_code}: ${j.error_message ?? ""}` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Modal>
  );
}

/**
 * 删除前的确认对话框。参数：onDeleted 删除成功后的回调。
 */
export function DeleteDialog({
  document,
  onClose,
  onDeleted,
}: {
  document: DocumentMeta;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { api } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * 执行删除；失败显示错误并允许重试。
   */
  async function remove() {
    setBusy(true);
    try {
      await api.json(`/documents/${document.id}`, { method: "DELETE" });
      onDeleted();
      onClose();
    } catch (e) {
      setError(userMessage(e));
      setBusy(false);
    }
  }

  return (
    <Modal title="Delete this document?" onClose={onClose}>
      <p className="text-sm text-slate-700">
        <strong>
          {document.doc_code} v{document.version}
        </strong>{" "}
        — {document.title}. The document, its search index and the original file will be removed.
        This cannot be undone.
      </p>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" onClick={remove} disabled={busy}>
          Delete
        </Button>
      </div>
    </Modal>
  );
}
