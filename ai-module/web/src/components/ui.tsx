"use client";

/**
 * 文件：components/ui.tsx
 * 作用：基础界面组件：Button 按钮、Input 输入框、Select 下拉框、Field 带标签与错误提示的表单项、
 * Badge 徽标、Modal 对话框。
 * 主要思想：样式用 Tailwind；按钮的 variant（primary/secondary/ghost/danger）和 size 用
 * class-variance-authority 管理；cn 合并 class 名。Modal 带 role="dialog"、aria-modal，
 * 按 Esc 关闭；错误提示用 role="alert"，方便读屏软件和测试找到。
 */

import { cva, type VariantProps } from "class-variance-authority";
import {
  useEffect,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";

// 按钮样式：基础样式 + 四种外观（主要/次要/幽灵/危险）+ 两种尺寸
const button = cva(
  "inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-indigo-600 text-white hover:bg-indigo-700",
        secondary: "border border-slate-300 bg-white text-slate-800 hover:bg-slate-50",
        ghost: "text-slate-700 hover:bg-slate-100",
        danger: "bg-red-600 text-white hover:bg-red-700",
      },
      size: { sm: "h-8 px-3", md: "h-9 px-4" },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

/**
 * 按钮。variant 外观，size 尺寸；其余属性原样传给 <button>。
 */
export function Button({
  className,
  variant,
  size,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>) {
  return <button className={cn(button({ variant, size }), className)} {...props} />;
}

// 输入框与下拉框共用的样式
const field =
  "h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus-visible:outline-2 focus-visible:outline-indigo-600";

/**
 * 文本输入框。
 */
export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(field, className)} {...props} />;
}

/**
 * 下拉选择框。
 */
export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(field, className)} {...props} />;
}

/**
 * 表单项：标签 + 控件 + 提示文字；有错误时显示错误（role=alert）而隐藏提示。
 */
export function Field({
  label,
  error,
  children,
  hint,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-slate-700">{label}</span>
      {children}
      {hint && !error ? <span className="text-xs text-slate-500">{hint}</span> : null}
      {error ? (
        <span role="alert" className="text-xs text-red-600">
          {error}
        </span>
      ) : null}
    </label>
  );
}

// 徽标的颜色
const tones = {
  gray: "bg-slate-100 text-slate-700",
  green: "bg-emerald-100 text-emerald-800",
  amber: "bg-amber-100 text-amber-800",
  red: "bg-red-100 text-red-800",
  blue: "bg-sky-100 text-sky-800",
} as const;

/**
 * 小徽标，用颜色表示状态（如现行=绿、被取代=黄）。
 */
export function Badge({
  tone = "gray",
  children,
}: {
  tone?: keyof typeof tones;
  children: ReactNode;
}) {
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", tones[tone])}>
      {children}
    </span>
  );
}

/**
 * 对话框：遮罩 + 居中面板，Esc 或 ✕ 关闭。参数：title 标题；onClose 关闭回调；wide 是否加宽。
 */
export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "max-h-[90vh] w-full overflow-y-auto rounded-lg bg-white p-5 shadow-xl",
          wide ? "max-w-3xl" : "max-w-lg",
        )}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}
