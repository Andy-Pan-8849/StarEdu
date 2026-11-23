"use client";

import * as React from "react";
import { X } from "lucide-react";

/** 操作失败时发出的事件：弹窗开着时，把错误显示在弹窗里面（页面上的提示被遮罩盖住了）。 */
export const ACT_ERROR_EVENT = "admin:act-error";

/** 弹窗里面的内容读它：表格在弹窗里不做复选列和固定表头（弹窗自己滚动）。 */
export const InDialogContext = React.createContext(false);

/** 开着的弹窗，最后一个在最上面；Esc 只关最上面的。 */
const stack: object[] = [];

/** 弹窗：盖在页面上方居中显示，点遮罩或按 Esc 关闭。内容太高时在弹窗内部滚动。 */
export function Modal({ title, onClose, children, wide = false, closeLabel = "Close" }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean; closeLabel?: string }) {
  React.useEffect(() => {
    const me = {};
    stack.push(me);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && stack[stack.length - 1] === me) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); stack.splice(stack.indexOf(me), 1); };
  }, [onClose]);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    const onErr = (e: Event) => setError(String((e as CustomEvent).detail ?? ""));
    window.addEventListener(ACT_ERROR_EVENT, onErr);
    return () => window.removeEventListener(ACT_ERROR_EVENT, onErr);
  }, []);
  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={title} className={`modal-panel flex max-h-[88vh] w-full ${wide ? "max-w-5xl" : "max-w-xl"} flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl`}>
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-primary/10 px-5 py-3.5">
          <h2 className="truncate text-base font-semibold">{title}</h2>
          <button type="button" aria-label={closeLabel} title={closeLabel} className="-mr-1.5 rounded-md p-1.5 text-muted hover:bg-border/50 hover:text-foreground" onClick={onClose}>
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <InDialogContext.Provider value={true}><div onSubmitCapture={() => setError(null)}>{children}</div></InDialogContext.Provider>
          {error ? <p role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">{error}</p> : null}
        </div>
      </div>
    </div>
  );
}
