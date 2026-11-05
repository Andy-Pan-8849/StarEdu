/**
 * 文件：app/layout.tsx
 * 作用：Next.js 的根布局——所有页面共用的 <html>/<body> 外壳，设置页面标题和描述，
 *   并引入全局样式。
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "StarIT Assistant",
  description: "Policy and data assistant for StarIT Education",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
