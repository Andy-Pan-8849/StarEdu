"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/** 页内选项卡：下划线样式，选中的那个下面有一条主色线。 */
export function Tabs<T extends string>({ items, value, onChange, className }: { items: ReadonlyArray<{ key: T; label: string }>; value: T; onChange: (key: T) => void; className?: string }) {
  return (
    <div role="tablist" className={cn("mb-4 flex gap-1 overflow-x-auto border-b border-border", className)}>
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="tab"
          aria-selected={value === it.key}
          className={cn("-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm", value === it.key ? "border-primary font-medium text-primary" : "border-transparent text-muted hover:text-foreground")}
          onClick={() => onChange(it.key)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
