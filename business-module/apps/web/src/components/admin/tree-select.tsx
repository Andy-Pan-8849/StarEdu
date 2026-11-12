"use client";

import * as React from "react";
import { stateOf, toggle, type TreeNode } from "./tree";

/** 勾选树。cascade=true 时勾选父节点连同下级；半选状态由下级推出。 */
export function TreeSelect({
  nodes,
  value,
  onChange,
  cascade = true,
  disabled = false,
  label,
}: {
  nodes: TreeNode[];
  value: readonly string[];
  onChange: (ids: string[]) => void;
  cascade?: boolean;
  disabled?: boolean;
  label: string;
}) {
  const checked = React.useMemo(() => new Set(value), [value]);
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(new Set());

  const render = (node: TreeNode, depth: number): React.ReactNode => {
    const kids = node.children ?? [];
    const state = stateOf(node, checked);
    const isCollapsed = collapsed.has(node.id);
    return (
      <li key={node.id} role="treeitem" aria-expanded={kids.length ? !isCollapsed : undefined} aria-checked={state === "half" ? "mixed" : state === "checked"}>
        <div className="flex items-center gap-1.5 py-0.5" style={{ paddingLeft: depth * 16 }}>
          {kids.length > 0 ? (
            <button
              type="button"
              className="w-4 text-xs text-muted"
              aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${node.label}`}
              onClick={() => setCollapsed((c) => { const n = new Set(c); if (isCollapsed) n.delete(node.id); else n.add(node.id); return n; })}
            >
              {isCollapsed ? "▸" : "▾"}
            </button>
          ) : (
            <span className="w-4" />
          )}
          <label className="flex cursor-pointer items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              disabled={disabled}
              checked={state === "checked"}
              ref={(el) => { if (el) el.indeterminate = state === "half"; }}
              onChange={() => onChange([...toggle(nodes, checked, node.id, cascade)])}
            />
            {node.label}
          </label>
        </div>
        {kids.length > 0 && !isCollapsed ? <ul role="group">{kids.map((k) => render(k, depth + 1))}</ul> : null}
      </li>
    );
  };

  return (
    <ul role="tree" aria-label={label} aria-multiselectable="true" className="rounded-md border border-border p-2">
      {nodes.map((n) => render(n, 0))}
    </ul>
  );
}
