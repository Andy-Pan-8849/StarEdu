"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { MenuTreeShell } from "./menu-tree-shell";
import type { MenuNode } from "./menu-nav";
import { PAGES } from "./page-registry";
import { BannerStrip, NotificationBell } from "./notification-bell";
import { BrandNameContext } from "./brand-context";
import { PermissionProvider } from "./permissions";
import { HomePage } from "./pages/home-page";
import { PlatformHomePage } from "./pages/platform-home-page";
import { ProfilePage } from "./pages/profile-page";
import { SettingsContext, type UiSettings } from "./settings-context";

export function AdminShell({ menus, permissions, userName, brand, signOutAction = "/admin/auth/logout", wsPort, settings }: { menus: MenuNode[]; permissions: string[]; userName: string; brand?: { name: string; logoUrl: string | null }; signOutAction?: string; wsPort?: string; settings?: UiSettings }) {
  const t = useTranslations();
  const PlatformHome = React.useMemo(() => function PlatformHomeTab() { return <PlatformHomePage userName={userName} />; }, [userName]);
  return (
    <PermissionProvider permissions={permissions}>
      <SettingsContext.Provider value={settings ?? { pageSize: 20 }}>
      <BrandNameContext.Provider value={brand?.name ?? ""}>
      <MenuTreeShell
        menus={menus}
        pages={PAGES}
        userName={userName}
        brand={brand}
        // 租户的两个入口有首页和个人中心；平台控制台（没有消息中心）有自己的首页（平台运维关心的内容），没有个人中心
        homePage={wsPort === undefined ? PlatformHome : HomePage}
        profilePage={wsPort === undefined ? undefined : ProfilePage}
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
          home: t("shell.home"),
          profile: t("shell.profile"),
          language: t("language.label"),
          languageNames: { en: t("language.en"), zh: t("language.zh") },
        }}
      />
      </BrandNameContext.Provider>
      </SettingsContext.Provider>
    </PermissionProvider>
  );
}
