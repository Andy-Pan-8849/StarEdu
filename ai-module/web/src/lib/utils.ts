/**
 * 文件：lib/utils.ts
 * 作用：小工具：cn 合并 Tailwind 的 class 名（后面的覆盖冲突的前面的），formatTime
 *   把时间字符串转成本地格式。
 */

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * 合并 class 名：clsx 处理条件写法，twMerge 去掉冲突的 Tailwind 类。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * 把 ISO 时间格式化成本地时间；空值返回空串，无法解析原样返回。
 */
export function formatTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
