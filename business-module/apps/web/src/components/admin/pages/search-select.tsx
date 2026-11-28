"use client";

// 搜索选择：像下拉框一样选一项，但不一次把全部数据取出来——输入关键字，每次最多取 20 条（防抖 250 毫秒）。
import * as React from "react";
import { bff } from "@/lib/bff";

export const SEARCH_SELECT_LIMIT = 20;
export interface Picked { id: string; label: string }

export function SearchSelect<T extends { id: string }>({ label, path, toLabel, value, onChange, placeholder, hint, noMatches }: {
  label: string;
  /** 例如 "courses?status=enabled"；组件会加上 limit 和 q。 */
  path: string;
  toLabel: (row: T) => string;
  value: Picked | null;
  onChange: (v: Picked | null) => void;
  placeholder: string;
  hint: string;
  noMatches: string;
}) {
  const [q, setQ] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [rows, setRows] = React.useState<T[] | null>(null);
  React.useEffect(() => {
    if (!open) return;
    let live = true;
    const timer = setTimeout(() => {
      const sep = path.includes("?") ? "&" : "?";
      void bff<T[]>(`${path}${sep}limit=${SEARCH_SELECT_LIMIT}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`).then((r) => { if (live) setRows(r); }).catch(() => { if (live) setRows([]); });
    }, q ? 250 : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [open, q, path]);
  return (
    <div className="relative flex flex-col gap-1 text-sm">
      <label>
        {label}
        <input
          aria-label={label}
          className="mt-1 block w-64 rounded-md border border-border bg-transparent px-2 py-1"
          placeholder={placeholder}
          value={open ? q : (value?.label ?? "")}
          onFocus={() => { setQ(""); setOpen(true); }}
          onChange={(e) => setQ(e.target.value)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
      </label>
      {open ? (
        <ul role="listbox" aria-label={label} className="absolute left-0 top-full z-20 mt-1 max-h-60 w-80 overflow-y-auto rounded-md border border-border bg-background p-1 shadow">
          {rows === null ? <li className="px-2 py-1 text-muted">…</li> : rows.length === 0 ? <li className="px-2 py-1 text-muted">{noMatches}</li> : rows.map((r) => (
            <li key={r.id} role="option" aria-selected={value?.id === r.id} className="cursor-pointer rounded px-2 py-1 hover:bg-border/40" onMouseDown={(e) => { e.preventDefault(); onChange({ id: r.id, label: toLabel(r) }); setOpen(false); }}>{toLabel(r)}</li>
          ))}
          {rows && rows.length >= SEARCH_SELECT_LIMIT ? <li className="px-2 py-1 text-xs text-muted">{hint}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
