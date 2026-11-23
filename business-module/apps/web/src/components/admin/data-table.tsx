"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { InDialogContext } from "./modal";

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => React.ReactNode;
}

export interface Pagination {
  page: number; // 从 1 开始
  size: number;
  /** 知道总数时给；不知道（接口只返回一页）就给 hasMore */
  total?: number;
  hasMore?: boolean;
  onPageChange: (page: number) => void;
}

export interface TableLabels {
  previous: string;
  next: string;
  page: (page: number, pages: number) => string;
  /** 操作列的列名；不给就是 Actions */
  actions?: string;
  /** 复选相关的文字；不给就用英文 */
  selectAll?: string;
  selectRow?: string;
  selected?: (n: number) => string;
  clearSelection?: string;
}

export const pageCount = (total: number, size: number): number => Math.max(1, Math.ceil(total / Math.max(1, size)));

/** 表格下沿要留给分页条和页面底边的高度（px） */
const BOTTOM_GAP = 24;
const PAGER_HEIGHT = 40;

/**
 * 通用数据表格：
 *  - 第一列是复选框（selectable，默认开；在弹窗里默认关），选中后上方出现"已选 N 项"和 bulkActions；
 *  - key 为 "actions" 的列自动叫"操作"，放在最后；
 *  - 表头固定：表格区高度算到屏幕底边，记录在里面上下滚动，表头、上方的操作区和下方的分页条不动。
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  emptyText,
  loadingText = "Loading…",
  pagination,
  selectable,
  bulkActions,
  labels = { previous: "Previous", next: "Next", page: (p: number, n: number) => `Page ${p} of ${n}` },
}: {
  columns: Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  emptyText: string;
  loadingText?: string;
  pagination?: Pagination;
  /** 是否有复选列；默认：页面上的列表有，弹窗里的没有 */
  selectable?: boolean;
  /** 选中了记录时显示在表格上方的批量操作按钮 */
  bulkActions?: (selectedKeys: string[]) => React.ReactNode;
  labels?: TableLabels;
}) {
  const inDialog = React.useContext(InDialogContext);
  const hasSelect = selectable ?? !inDialog;
  // 点哪一行，哪一行高亮（只在本表内记着；换页或数据刷新后，该行不在了就自然没有高亮）
  const [highlight, setHighlight] = React.useState<string | null>(null);
  // 复选的记录；换页或刷新后不在当前页的自动丢掉
  const [checked, setChecked] = React.useState<ReadonlySet<string>>(new Set());
  const keys = React.useMemo(() => rows.map(rowKey), [rows, rowKey]);
  const live = React.useMemo(() => keys.filter((k) => checked.has(k)), [keys, checked]);
  const allChecked = keys.length > 0 && live.length === keys.length;
  const someChecked = live.length > 0 && !allChecked;
  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(keys));
  const toggleOne = (k: string) => setChecked((c) => { const n = new Set(c); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  // 表格区高度：从它顶部到屏幕底边，减去分页条；弹窗里不限制（弹窗自己滚动）
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [maxHeight, setMaxHeight] = React.useState<number | undefined>(undefined);
  const fit = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el || inDialog) return;
    const top = el.getBoundingClientRect().top;
    setMaxHeight(Math.max(180, Math.floor(window.innerHeight - top - BOTTOM_GAP - (pagination ? PAGER_HEIGHT : 0))));
  }, [inDialog, pagination]);
  React.useLayoutEffect(() => { fit(); });
  React.useEffect(() => {
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [fit]);

  const pages = pagination && pagination.total !== undefined ? pageCount(pagination.total, pagination.size) : null;
  const lastPage = pagination ? (pages !== null ? pagination.page >= pages : !pagination.hasMore) : true;
  const span = columns.length + (hasSelect ? 1 : 0);
  // "操作"列永远排在最后
  const ordered = [...columns.filter((c) => c.key !== "actions"), ...columns.filter((c) => c.key === "actions")];
  const headerOf = (c: Column<T>) => (c.key === "actions" && c.header === "" ? (labels.actions ?? "Actions") : c.header);
  const th = "sticky top-0 z-10 bg-slate-100 dark:bg-slate-800 px-3 py-2.5 text-xs font-medium uppercase tracking-wide text-muted";

  return (
    <div className="flex flex-col gap-2">
      {hasSelect && bulkActions && live.length > 0 ? (
        <div className="flex items-center gap-3 rounded-md border border-primary/30 bg-primary/10 px-3 py-1.5 text-sm">
          <span className="font-medium">{labels.selected ? labels.selected(live.length) : `${live.length} selected`}</span>
          {bulkActions(live)}
          <button type="button" className="ml-auto text-muted hover:text-foreground" onClick={() => setChecked(new Set())}>{labels.clearSelection ?? "Clear"}</button>
        </div>
      ) : null}
      <div ref={scrollRef} className="overflow-auto rounded-md border border-border" style={maxHeight ? { maxHeight } : undefined}>
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              {hasSelect ? (
                <th scope="col" className={cn(th, "w-10")}>
                  <input
                    type="checkbox"
                    aria-label={labels.selectAll ?? "Select all"}
                    checked={allChecked}
                    ref={(el) => { if (el) el.indeterminate = someChecked; }}
                    disabled={keys.length === 0}
                    onChange={toggleAll}
                  />
                </th>
              ) : null}
              {ordered.map((c) => (
                <th key={c.key} scope="col" className={cn(th, c.key === "actions" && "text-right")}>
                  {headerOf(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody aria-busy={loading}>
            {loading ? (
              <tr>
                <td colSpan={span} className="px-3 py-6 text-center text-muted">
                  {loadingText}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={span} className="px-3 py-6 text-center text-muted">
                  {emptyText}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const key = rowKey(row);
                const isHighlighted = key === highlight;
                const isChecked = checked.has(key);
                return (
                  <tr
                    key={key}
                    aria-selected={isHighlighted}
                    data-selected={isHighlighted ? "true" : undefined}
                    onClick={() => setHighlight(key)}
                    className={cn("border-t border-border hover:bg-border/20", isChecked && "bg-primary/5", isHighlighted && "bg-primary/15 outline outline-1 -outline-offset-1 outline-primary/60")}
                  >
                    {hasSelect ? (
                      <td className="w-10 px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" aria-label={labels.selectRow ?? "Select row"} checked={isChecked} onChange={() => toggleOne(key)} />
                      </td>
                    ) : null}
                    {ordered.map((c) => (
                      <td key={c.key} className={cn("px-3 py-2", c.key === "actions" && "whitespace-nowrap text-right")}>
                        {c.key === "actions" ? <div className="flex flex-wrap justify-end gap-1.5">{c.cell(row)}</div> : c.cell(row)}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {pagination ? (
        <div className="flex items-center justify-end gap-2 text-sm text-muted">
          <Button size="sm" variant="outline" disabled={pagination.page <= 1} onClick={() => pagination.onPageChange(pagination.page - 1)}>
            {labels.previous}
          </Button>
          <span>{pages !== null ? labels.page(pagination.page, pages) : `${pagination.page}`}</span>
          <Button size="sm" variant="outline" disabled={lastPage} onClick={() => pagination.onPageChange(pagination.page + 1)}>
            {labels.next}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
