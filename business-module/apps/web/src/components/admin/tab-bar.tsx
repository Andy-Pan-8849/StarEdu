"use client";

import * as React from "react";
import type { TabsState } from "./tabs-state";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export function TabBar({ state, onActivate, onClose, closeLabel }: { state: TabsState; onActivate: (id: string) => void; onClose: (id: string) => void; closeLabel: string }) {
  return (
    <div role="tablist" className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-border/10 px-2 pt-1.5">
      {state.tabs.map((tab) => (
        <div key={tab.id} className={cn("flex items-center gap-1.5 rounded-t-md border border-b-0 px-3 py-1.5 text-sm", tab.id === state.activeId ? "border-border bg-background font-medium text-primary" : "border-transparent text-muted hover:text-foreground")}>
          <button type="button" role="tab" aria-selected={tab.id === state.activeId} onClick={() => onActivate(tab.id)}>
            {tab.title}
          </button>
          {tab.pinned ? null : (
            <button type="button" aria-label={`${closeLabel} ${tab.title}`} className="text-muted hover:text-foreground" onClick={() => onClose(tab.id)}>
              <X aria-hidden className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
