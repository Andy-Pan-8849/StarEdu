"use client";

/**
 * 文件：components/app-shell.tsx
 * 作用：登录后的页面外壳：顶部栏（标题、主菜单、当前用户、退出按钮）+ 下面放页面内容。
 * 主要思想：先等登录完成（loading 显示“Signing in…”，error 显示重试）；
 * 菜单项由 /me 返回的角色决定（有管理角色才出现 Documents）。隐藏链接只是方便，
 * API 对每个请求都会再校验，所以不依赖这里。
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useAuth } from "@/components/auth-provider";
import { LogoMark } from "@/components/logo";
import { Button } from "@/components/ui";
import { canManageDocuments } from "@/lib/auth";
import { cn } from "@/lib/utils";

/**
 * 等登录完成后显示菜单与内容。菜单内容只取决于 /me；API 会再次检查每个请求，
 *   所以隐藏链接从来不是保护手段。
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { state, signOut, retry } = useAuth();
  const path = usePathname();

  if (state.status === "loading") {
    return <p className="p-8 text-sm text-slate-500">Signing in…</p>;
  }
  if (state.status === "error") {
    return (
      <div className="p-8 text-sm">
        <p role="alert" className="mb-3 text-red-700">
          {state.message}
        </p>
        <Button onClick={retry}>Try again</Button>
      </div>
    );
  }
  const { me } = state;
  const links = [{ href: "/", label: "Assistant" }];
  if (canManageDocuments(me.roles)) links.push({ href: "/admin/documents", label: "Documents" });

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-6 border-b border-slate-200 bg-white px-5 py-2">
        <span className="flex items-center gap-2 font-semibold text-slate-900">
          <LogoMark size={28} />
          StarIT Assistant
        </span>
        <nav aria-label="Main" className="flex gap-1">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100",
                path === link.href && "bg-slate-100 font-medium text-slate-900",
              )}
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm text-slate-600">
          <span data-testid="who">
            {me.name} · {me.roles.join(", ") || "no role"}
            {me.campus_id ? ` · ${me.campus_id}` : ""}
          </span>
          <Button variant="secondary" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </header>
      <main className="min-h-0 flex-1">{children}</main>
    </div>
  );
}
