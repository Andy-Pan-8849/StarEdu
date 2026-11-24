"use client";

import { useTranslations } from "next-intl";
import { MenuTreeShell } from "./menu-tree-shell";
import type { MenuNode } from "./menu-nav";
import { PAGES } from "./page-registry";
import { BannerStrip, NotificationBell } from "./notification-bell";
import { BrandNameContext } from "./brand-context";
import { PermissionProvider } from "./permissions";
import { SettingsContext, type UiSettings } from "./settings-context";

export function AdminShell({ menus, permissions, userName, brand, signOutAction = "/admin/auth/logout", wsPort, settings }: { menus: MenuNode[]; permissions: string[]; userName: string; brand?: { name: string; logoUrl: string | null }; signOutAction?: string; wsPort?: string; settings?: UiSettings }) {
  const t = useTranslations();
  return (
    <PermissionProvider permissions={permissions}>
      <SettingsContext.Provider value={settings ?? { pageSize: 20 }}>
      <BrandNameContext.Provider value={brand?.name ?? ""}>
      <MenuTreeShell
        menus={menus}
        pages={PAGES}
        userName={userName}
        brand={brand}
        signOutAction={signOutAction}
        // 平台控制台没有消息中心（wsPort 为 undefined 时不显示）
        headerExtra={wsPort === undefined ? null : <NotificationBell wsPort={wsPort} />}
        topExtra={wsPort === undefined ? null : <BannerStrip />}
        label={(node) => (node.nameKey && t.has(node.nameKey) ? t(node.nameKey) : node.name)}
        labels={{
          closeTab: t("shell.closeTab"),
          noMenus: t("shell.noMenus"),
          pageNotBuilt: t("shell.pageNotBuilt"),
          signedInAs: t("shell.signedInAs"),
          signOut: t("shell.signOut"),
          searchMenus: t("shell.searchMenus"),
          collapseMenu: t("shell.collapseMenu"),
          expandMenu: t("shell.expandMenu"),
        }}
      />
      </BrandNameContext.Provider>
      </SettingsContext.Provider>
    </PermissionProvider>
  );
}
