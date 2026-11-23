"use client";

import * as React from "react";

/** 弹窗：盖在页面上方居中显示，点遮罩或按 Esc 关闭。内容太高时在弹窗内部滚动。 */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={title} className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-md border border-border bg-background p-4 shadow-lg">
        {children}
      </div>
    </div>
  );
}
