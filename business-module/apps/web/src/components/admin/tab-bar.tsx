"use client";

import * as React from "react";
import type { TabsState } from "./tabs-state";
import { cn } from "@/lib/utils";

export function TabBar({ state, onActivate, onClose, closeLabel }: { state: TabsState; onActivate: (id: string) => void; onClose: (id: string) => void; closeLabel: string }) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-border px-2">
      {state.tabs.map((tab) => (
        <div key={tab.id} className={cn("flex items-center gap-1 rounded-t-md px-3 py-1.5 text-sm", tab.id === state.activeId ? "bg-border/40 font-medium" : "text-muted")}>
          <button type="button" role="tab" aria-selected={tab.id === state.activeId} onClick={() => onActivate(tab.id)}>
            {tab.title}
          </button>
          <button type="button" aria-label={`${closeLabel} ${tab.title}`} className="text-muted hover:text-foreground" onClick={() => onClose(tab.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
