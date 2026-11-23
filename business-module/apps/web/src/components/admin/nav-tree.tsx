"use client";

import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface NavNode {
  id: string;
  label: string;
  icon?: React.ReactNode;
  /** 名字后面的小字（数量等） */
  hint?: string;
  children: NavNode[];
}

/**
 * 分层导航树：缩进加竖线，一眼看出包含关系；有下级的节点可以折叠；选中项高亮。
 * 文档库的文件夹、组织架构的部门共用。
 */
export function NavTree({
  nodes,
  selectedId,
  onSelect,
  collapseLabel = "Collapse",
  expandLabel = "Expand",
  label,
}: {
  nodes: readonly NavNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  collapseLabel?: string;
  expandLabel?: string;
  label: string;
}) {
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const renderNode = (node: NavNode, depth: number): React.ReactNode => {
    const hasKids = node.children.length > 0;
    const isCollapsed = collapsed.has(node.id);
    const active = node.id === selectedId;
    return (
      <li key={node.id} role="treeitem" aria-selected={active} aria-expanded={hasKids ? !isCollapsed : undefined}>
        <div className={cn("group flex items-center rounded-md", active ? "bg-primary/10 text-primary" : "hover:bg-border/40")}>
          {hasKids ? (
            <button type="button" aria-label={`${isCollapsed ? expandLabel : collapseLabel} ${node.label}`} className="flex h-7 w-6 shrink-0 items-center justify-center text-muted hover:text-foreground" onClick={() => toggle(node.id)}>
              {isCollapsed ? <ChevronRight aria-hidden className="h-4 w-4" /> : <ChevronDown aria-hidden className="h-4 w-4" />}
            </button>
          ) : (
            <span aria-hidden className="w-6 shrink-0" />
          )}
          <button type="button" className={cn("flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-left text-sm", active && "font-medium")} onClick={() => onSelect(node.id)}>
            {node.icon ? <span className="shrink-0 text-muted group-hover:text-current">{node.icon}</span> : null}
            <span className="truncate">{node.label}</span>
            {node.hint ? <span className="ml-auto shrink-0 text-xs text-muted">{node.hint}</span> : null}
          </button>
        </div>
        {hasKids && !isCollapsed ? <ul role="group" className="ml-3 border-l border-border pl-1">{node.children.map((c) => renderNode(c, depth + 1))}</ul> : null}
      </li>
    );
  };

  return <ul role="tree" aria-label={label} className="space-y-0.5">{nodes.map((n) => renderNode(n, 0))}</ul>;
}
