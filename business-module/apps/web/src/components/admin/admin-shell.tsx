"use client";

import { useTranslations } from "next-intl";
import { MenuTreeShell } from "./menu-tree-shell";
import type { MenuNode } from "./menu-nav";
import { PAGES } from "./page-registry";
import { PermissionProvider } from "./permissions";

export function AdminShell({ menus, permissions, userName }: { menus: MenuNode[]; permissions: string[]; userName: string }) {
  const t = useTranslations();
  return (
    <PermissionProvider permissions={permissions}>
      <MenuTreeShell
        menus={menus}
        pages={PAGES}
        userName={userName}
        signOutAction="/admin/auth/logout"
        label={(node) => (node.nameKey && t.has(node.nameKey) ? t(node.nameKey) : node.name)}
        labels={{
          closeTab: t("shell.closeTab"),
          noMenus: t("shell.noMenus"),
          pageNotBuilt: t("shell.pageNotBuilt"),
          signedInAs: t("shell.signedInAs"),
          signOut: t("shell.signOut"),
        }}
      />
    </PermissionProvider>
  );
}
