"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui";
import { canManageDocuments } from "@/lib/auth";
import { cn } from "@/lib/utils";

/** Waits for sign-in, then shows the menu. What the menu shows comes from /me only; the API
 * checks every request again, so hiding a link is never the protection. */
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
        <span className="font-semibold text-slate-900">StarIT Assistant</span>
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
