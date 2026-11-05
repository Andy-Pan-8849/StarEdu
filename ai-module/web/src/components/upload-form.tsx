"use client";

/**
 * 文件：components/upload-form.tsx
 * 作用：上传文档的表单：选文件，填编号、版本、标题、领域，选谁能读、状态、生效日、校区范围、
 * 最低职等和额外允许的用户。
 * 主要思想：先用 validateUpload 做前端校验（与服务端规则一致，错误立刻显示在字段旁）；
 * 通过后用 FormData 提交到 POST /documents（服务端返回 202，解析和嵌入在后台进行）；
 * 成功后清空表单并通知父组件刷新列表。服务端仍会重新校验，前端校验只是为了少一次来回。
 */

import { useState, type FormEvent } from "react";
import { useAuth } from "@/components/auth-provider";
import { Button, Field, Input, Select } from "@/components/ui";
import { userMessage } from "@/lib/api";
import { ACCESS_LEVELS, DOMAINS, type DocumentMeta } from "@/lib/types";
import { splitList, validateUpload } from "@/lib/validation";

// 表单初始值（也是成功后重置的值）
const EMPTY = {
  doc_code: "",
  title: "",
  domain: "hr",
  version: "1.0",
  access_level: "all-staff",
  status: "active",
  effective_date: "",
  campus_scope: "all",
  allowed_users: "",
  min_level: "",
};

/**
 * 上传表单。参数：onUploaded——上传成功后的回调，带回新建的文档。
 */
export function UploadForm({ onUploaded }: { onUploaded: (document: DocumentMeta) => void }) {
  const { api } = useAuth();
  const [fields, setFields] = useState(EMPTY);
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileKey, setFileKey] = useState(0);

  // 生成某个字段的 onChange 处理函数
  const set = (name: keyof typeof EMPTY) => (event: { target: { value: string } }) =>
    setFields((f) => ({ ...f, [name]: event.target.value }));

  /**
   * 提交：前端校验 -> 组装 FormData（逗号分隔的校区和用户拆成多个同名字段）-> 调接口 ->
   *   重置表单。
   */
  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    const found = validateUpload(fields, file);
    setErrors(found);
    if (Object.keys(found).length > 0 || file === null) return;
    const form = new FormData();
    form.append("file", file);
    for (const name of [
      "doc_code",
      "title",
      "domain",
      "version",
      "access_level",
      "status",
    ] as const) {
      form.append(name, fields[name].trim());
    }
    if (fields.effective_date) form.append("effective_date", fields.effective_date);
    if (fields.min_level.trim()) form.append("min_level", fields.min_level.trim());
    for (const scope of splitList(fields.campus_scope)) form.append("campus_scope", scope);
    for (const user of splitList(fields.allowed_users)) form.append("allowed_users", user);
    setBusy(true);
    try {
      const created = await api.json<{ document: DocumentMeta }>("/documents", {
        method: "POST",
        form,
      });
      setFields(EMPTY);
      setFile(null);
      // 换一个 key 让文件选择框重新创建，从而清空已选文件（文件框不能用代码清空）
      setFileKey((k) => k + 1);
      onUploaded(created.document);
    } catch (e) {
      setFailure(userMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Upload a document"
      className="grid gap-3 sm:grid-cols-2"
    >
      <div className="sm:col-span-2">
        <Field label="File (docx, pdf, md or txt, up to 20 MB)" error={errors.file}>
          <input
            key={fileKey}
            type="file"
            aria-label="File"
            accept=".docx,.pdf,.md,.txt"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-sm"
          />
        </Field>
      </div>
      <Field label="Document code" error={errors.doc_code}>
        <Input
          aria-label="Document code"
          value={fields.doc_code}
          onChange={set("doc_code")}
          placeholder="HR-REC-001"
        />
      </Field>
      <Field label="Version" error={errors.version}>
        <Input aria-label="Version" value={fields.version} onChange={set("version")} />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Title" error={errors.title}>
          <Input aria-label="Title" value={fields.title} onChange={set("title")} />
        </Field>
      </div>
      <Field label="Domain" error={errors.domain}>
        <Select aria-label="Domain" value={fields.domain} onChange={set("domain")}>
          {DOMAINS.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </Select>
      </Field>
      <Field label="Who may read it" error={errors.access_level}>
        <Select
          aria-label="Who may read it"
          value={fields.access_level}
          onChange={set("access_level")}
        >
          {ACCESS_LEVELS.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </Select>
      </Field>
      <Field label="Status">
        <Select aria-label="Status" value={fields.status} onChange={set("status")}>
          <option>active</option>
          <option>superseded</option>
          <option>draft</option>
        </Select>
      </Field>
      <Field label="Effective date">
        <Input
          aria-label="Effective date"
          type="date"
          value={fields.effective_date}
          onChange={set("effective_date")}
        />
      </Field>
      <Field label="Campuses" hint="Comma separated, or all">
        <Input aria-label="Campuses" value={fields.campus_scope} onChange={set("campus_scope")} />
      </Field>
      <Field
        label="Minimum grade (1–7)"
        error={errors.min_level}
        hint="Leave empty for no requirement"
      >
        <Input
          aria-label="Minimum grade"
          value={fields.min_level}
          onChange={set("min_level")}
          inputMode="numeric"
        />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Also allow these users" hint="Comma separated user ids; optional">
          <Input
            aria-label="Allowed users"
            value={fields.allowed_users}
            onChange={set("allowed_users")}
          />
        </Field>
      </div>
      {failure ? (
        <p role="alert" className="text-sm text-red-700 sm:col-span-2">
          {failure}
        </p>
      ) : null}
      <div className="sm:col-span-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Uploading…" : "Upload"}
        </Button>
      </div>
    </form>
  );
}
