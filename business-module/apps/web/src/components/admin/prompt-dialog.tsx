"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "./modal";

export interface PromptField {
  name: string;
  label: string;
  initial?: string;
  type?: "text" | "number" | "date" | "textarea" | "select";
  options?: Array<{ value: string; label: string }>;
}
type Values = Record<string, string>;

/**
 * 代替 window.prompt：弹出一个带输入框的窗口。
 * `const { ask, dialog } = usePromptDialog();` 在页面里放上 `{dialog}`，然后 `const v = await ask("标题", [字段…])`，
 * 点保存得到 {字段名: 文字}，点取消（或按 Esc）得到 null。
 */
export function usePromptDialog() {
  const [state, setState] = React.useState<{ title: string; fields: PromptField[]; resolve: (v: Values | null) => void } | null>(null);
  const ask = React.useCallback((title: string, fields: PromptField[]) => new Promise<Values | null>((resolve) => setState({ title, fields, resolve })), []);
  const finish = (v: Values | null) => { state?.resolve(v); setState(null); };
  const dialog = state ? <PromptForm key={state.title} title={state.title} fields={state.fields} onDone={finish} /> : null;
  return { ask, dialog };
}

function PromptForm({ title, fields, onDone }: { title: string; fields: PromptField[]; onDone: (v: Values | null) => void }) {
  const c = useTranslations("crud");
  const [values, setValues] = React.useState<Values>(() => Object.fromEntries(fields.map((f) => [f.name, f.initial ?? ""])));
  const cls = "rounded-md border border-border bg-transparent px-2 py-1";
  return (
    <Modal title={title} onClose={() => onDone(null)}>
      <form className="flex flex-col gap-3 text-sm" onSubmit={(e) => { e.preventDefault(); onDone(values); }}>
        <h3 className="text-base font-semibold">{title}</h3>
        {fields.map((f) => (
          <label key={f.name} className="flex flex-col gap-1">{f.label}
            {f.type === "select"
              ? <select className={cls} required value={values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}><option value="" />{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
              : f.type === "textarea"
              ? <textarea className={cls} rows={3} required value={values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
              : <input className={cls} type={f.type ?? "text"} required value={values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />}
          </label>
        ))}
        <div className="mt-2 flex justify-start gap-2 border-t border-border pt-3">
          <Button type="submit" size="sm">{c("save")}</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => onDone(null)}>{c("cancel")}</Button>
        </div>
      </form>
    </Modal>
  );
}
