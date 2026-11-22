"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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

export const pageCount = (total: number, size: number): number => Math.max(1, Math.ceil(total / Math.max(1, size)));

/** 通用数据表格：列配置、加载中/空状态、分页。操作列直接用 cell 渲染权限按钮。 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  emptyText,
  loadingText = "Loading…",
  pagination,
  labels = { previous: "Previous", next: "Next", page: (p: number, n: number) => `Page ${p} of ${n}` },
}: {
  columns: Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  emptyText: string;
  loadingText?: string;
  pagination?: Pagination;
  labels?: { previous: string; next: string; page: (page: number, pages: number) => string };
}) {
  // 点哪一行，哪一行高亮（只在本表内记着；换页或数据刷新后，该行不在了就自然没有高亮）
  const [selected, setSelected] = React.useState<string | null>(null);
  const pages = pagination && pagination.total !== undefined ? pageCount(pagination.total, pagination.size) : null;
  const lastPage = pagination ? (pages !== null ? pagination.page >= pages : !pagination.hasMore) : true;
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-border/30 text-muted">
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className="px-3 py-2 font-medium">
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody aria-busy={loading}>
            {loading ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-6 text-center text-muted">
                  {loadingText}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-6 text-center text-muted">
                  {emptyText}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const key = rowKey(row);
                const isSelected = key === selected;
                return (
                <tr
                  key={key}
                  aria-selected={isSelected}
                  data-selected={isSelected ? "true" : undefined}
                  onClick={() => setSelected(key)}
                  className={cn("border-t border-border hover:bg-border/20", isSelected && "bg-primary/15 outline outline-1 -outline-offset-1 outline-primary/60")}
                >
                  {columns.map((c) => (
                    <td key={c.key} className="px-3 py-2">
                      {c.cell(row)}
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
