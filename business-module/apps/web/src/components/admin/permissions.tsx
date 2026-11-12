"use client";

// 权限上下文：前端同一份权限码常量（@staredu/shared 的 PERMS）控制按钮显示。
// 没有权限就不渲染——但这只是方便；接口每次都校验。
import * as React from "react";
import { Button, type ButtonProps } from "@/components/ui/button";

const PermissionContext = React.createContext<ReadonlySet<string>>(new Set());

export function PermissionProvider({ permissions, children }: { permissions: readonly string[]; children: React.ReactNode }) {
  const set = React.useMemo(() => new Set(permissions), [permissions]);
  return <PermissionContext.Provider value={set}>{children}</PermissionContext.Provider>;
}

export function usePermissions() {
  const set = React.useContext(PermissionContext);
  return React.useMemo(
    () => ({
      has: (perm: string) => set.has(perm),
      hasAll: (perms: readonly string[]) => perms.every((p) => set.has(p)),
      hasAny: (perms: readonly string[]) => perms.some((p) => set.has(p)),
    }),
    [set],
  );
}

/** 同时具备 perm（或 all 里的全部；或 any 里的任意一个）才渲染 children。 */
export function Can({ perm, all, any, children }: { perm?: string; all?: readonly string[]; any?: readonly string[]; children: React.ReactNode }) {
  const p = usePermissions();
  const ok = (perm === undefined || p.has(perm)) && (all === undefined || p.hasAll(all)) && (any === undefined || p.hasAny(any));
  return ok ? <>{children}</> : null;
}

/** 权限按钮：没有权限就不渲染（和竞品的 v-hasPermi 一样）。 */
export function PermButton({ perm, ...props }: ButtonProps & { perm: string }) {
  const p = usePermissions();
  return p.has(perm) ? <Button {...props} /> : null;
}
