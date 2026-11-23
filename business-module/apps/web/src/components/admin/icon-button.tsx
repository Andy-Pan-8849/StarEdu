"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePermissions } from "./permissions";

/**
 * 鼠标移上去（或键盘聚焦）时在下方显示提示文字的外壳。
 * 提示用 fixed 定位，不会被表格、弹窗这些带滚动的容器裁掉。
 */
export function Tip({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  const [pos, setPos] = React.useState<{ x: number; y: number } | null>(null);
  const show = (e: React.SyntheticEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setPos({ x: r.left + r.width / 2, y: r.bottom + 6 });
  };
  return (
    <span className={cn("relative inline-flex", className)} onMouseEnter={show} onMouseLeave={() => setPos(null)} onFocus={show} onBlur={() => setPos(null)}>
      {children}
      {pos ? (
        <span role="tooltip" className="pointer-events-none fixed z-[60] -translate-x-1/2 whitespace-nowrap rounded bg-slate-900 px-2 py-1 text-xs text-white shadow" style={{ left: pos.x, top: pos.y }}>
          {label}
        </span>
      ) : null}
    </span>
  );
}

/** 图标按钮：只显示图标，名字（无障碍名和提示）是 label。className 作用在外壳上，方便留边距。 */
export function IconButton({ icon: Icon, label, className, ...props }: Omit<ButtonProps, "children" | "aria-label"> & { icon: LucideIcon; label: string }) {
  return (
    <Tip label={label} className={className}>
      <Button size="sm" {...props} aria-label={label} className="px-2">
        <Icon aria-hidden className="h-4 w-4" />
      </Button>
    </Tip>
  );
}

/** 没有权限就不渲染的图标按钮。 */
export function PermIconButton({ perm, ...props }: Omit<ButtonProps, "children" | "aria-label"> & { icon: LucideIcon; label: string; perm: string }) {
  return usePermissions().has(perm) ? <IconButton {...props} /> : null;
}

/** 图标样式的链接（下载、导出）。 */
export function IconLink({ icon: Icon, label, href, className }: { icon: LucideIcon; label: string; href: string; className?: string }) {
  return (
    <Tip label={label} className={className}>
      <a href={href} aria-label={label} className="inline-flex h-8 items-center justify-center rounded-md border border-border px-2 hover:bg-border/40">
        <Icon aria-hidden className="h-4 w-4" />
      </a>
    </Tip>
  );
}

/** 表格行里的操作：图标加文字，没有按钮边框（样式由表格操作列统一）。danger 为红色（删除类）。 */
export function RowAction({ icon: Icon, danger = false, className, children, ...props }: Omit<ButtonProps, "size" | "variant"> & { icon: LucideIcon; danger?: boolean }) {
  return (
    <Button size="sm" variant="outline" {...props} className={cn("gap-1", danger && "!text-red-600", className)}>
      <Icon aria-hidden className="h-3.5 w-3.5" />
      {children}
    </Button>
  );
}

export function PermRowAction({ perm, ...props }: Omit<ButtonProps, "size" | "variant"> & { icon: LucideIcon; danger?: boolean; perm: string }) {
  return usePermissions().has(perm) ? <RowAction {...props} /> : null;
}
