"use client";

// 管理页面共用的小零件：表单面板、操作提示。
import * as React from "react";
import { Button } from "@/components/ui/button";
import { ACT_ERROR_EVENT, Modal } from "../modal";

export interface Field {
  name: string;
  label: string;
  type?: "text" | "number" | "email" | "datetime-local" | "select" | "checkbox" | "textarea";
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
  readOnly?: boolean;
}

type Values = Record<string, string | boolean>;

/** 把表单里的文字转成接口要的值：数字转数字、空文字去掉、复选框是布尔。 */
export function toPayload(fields: Field[], values: Values): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.readOnly) continue;
    const v = values[f.name];
    if (f.type === "checkbox") out[f.name] = Boolean(v);
    else if (v === "" || v === undefined) continue;
    else out[f.name] = f.type === "number" ? Number(v) : v;
  }
  return out;
}

export function FormPanel({
  title,
  fields,
  initial = {},
  submitLabel,
  cancelLabel,
  onSubmit,
  onCancel,
  inline = false,
}: {
  title: string;
  fields: Field[];
  initial?: Values;
  submitLabel: string;
  cancelLabel: string;
  onSubmit: (payload: Record<string, unknown>) => void | Promise<void>;
  onCancel: () => void;
  /** 默认以弹窗显示；已经在弹窗里面时用 inline，直接在原位显示。 */
  inline?: boolean;
}) {
  const [values, setValues] = React.useState<Values>(() => Object.fromEntries(fields.map((f) => [f.name, initial[f.name] ?? (f.type === "checkbox" ? false : "")])));
  const set = (name: string, v: string | boolean) => setValues((s) => ({ ...s, [name]: v }));
  const cls = "rounded-md border border-border bg-transparent px-2 py-1";
  const form = (
    <form
      className={inline ? "mb-3 flex flex-col gap-3 rounded-md border border-border p-3 text-sm" : "flex flex-col gap-3 text-sm"}
      aria-label={title}
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(toPayload(fields, values));
      }}
    >
      <h3 className="text-base font-semibold">{title}</h3>
      {fields.map((f) => (
        <label key={f.name} className={f.type === "checkbox" ? "flex items-center gap-2" : "flex flex-col gap-1"}>
          {f.type === "checkbox" ? null : f.label}
          {f.type === "select" ? (
            <select className={cls} required={f.required} disabled={f.readOnly} value={String(values[f.name])} onChange={(e) => set(f.name, e.target.value)}>
              <option value="" />
              {f.options?.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
          ) : f.type === "checkbox" ? (
            <><input type="checkbox" disabled={f.readOnly} checked={Boolean(values[f.name])} onChange={(e) => set(f.name, e.target.checked)} />{f.label}</>
          ) : f.type === "textarea" ? (
            <textarea className={cls} rows={4} required={f.required} readOnly={f.readOnly} value={String(values[f.name])} onChange={(e) => set(f.name, e.target.value)} />
          ) : (
            <input className={cls} type={f.type ?? "text"} required={f.required} readOnly={f.readOnly} value={String(values[f.name])} onChange={(e) => set(f.name, e.target.value)} />
          )}
        </label>
      ))}
      <div className="mt-2 flex justify-start gap-2 border-t border-border pt-3">
        <Button type="submit" size="sm">{submitLabel}</Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>{cancelLabel}</Button>
      </div>
    </form>
  );
  return inline ? form : <Modal title={title} onClose={onCancel}>{form}</Modal>;
}

/** 操作结果提示 + 统一的"执行并刷新"。 */
export function useAct(reload: () => void) {
  const [message, setMessage] = React.useState<{ text: string; error: boolean } | null>(null);
  const run = React.useCallback(
    async (fn: () => Promise<unknown>, ok?: string) => {
      try {
        await fn();
        setMessage(ok ? { text: ok, error: false } : null);
        reload();
        return true;
      } catch (e) {
        setMessage({ text: (e as Error).message, error: true });
        window.dispatchEvent(new CustomEvent(ACT_ERROR_EVENT, { detail: (e as Error).message }));
        return false;
      }
    },
    [reload],
  );
  const view = message ? (
    <p role={message.error ? "alert" : "status"} className={`mb-2 text-sm ${message.error ? "text-red-600" : "text-muted"}`}>{message.text}</p>
  ) : null;
  return { run, message: view, setMessage };
}
