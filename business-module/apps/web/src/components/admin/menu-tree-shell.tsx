"use client";

// 管理后台外壳：左侧菜单树 + 顶部标签页 + 内容区（竞品式布局）。
//   - 目录可展开；"菜单"点击在标签页打开；"外链"在新窗口打开（租户自己的网址）；
//   - 页面组件是构建时打包的：按菜单的"组件路径"在 pages 里找；还没有的显示占位说明，不报错。
import * as React from "react";
import { ChevronDown, ChevronRight, ExternalLink, House, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { LogoMark } from "../logo-mark";
import { MenuIcon } from "./menu-icon";
import { filterMenus, findByComponent, firstOpenable, findMenu, type MenuNode } from "./menu-nav";
import { NavContext } from "./nav-context";
import { TabBar } from "./tab-bar";
import { closeTab, emptyTabs, openTab, type TabsState } from "./tabs-state";
import { UserMenu, type UserMenuLabels } from "./user-menu";

/** 不在后端菜单数据里的两个固定页面：首页（菜单树最上面的入口，也是固定标签页）和个人中心（从头像菜单打开）。 */
export const HOME_ID = "@home";
export const PROFILE_ID = "@profile";

export interface ShellLabels {
  closeTab: string;
  noMenus: string;
  pageNotBuilt: string;
  signedInAs: string;
  signOut: string;
  /** 首页、个人中心的标签页名字，和头像菜单里的文字；不给就用英文 */
  home?: string;
  profile?: string;
  language?: string;
  languageNames?: Record<string, string>;
  /** 以下三项是菜单搜索框和折叠按钮的文字；不给就用英文 */
  searchMenus?: string;
  collapseMenu?: string;
  expandMenu?: string;
}

/** 外链里的 {code} 换成当前租户代码（域名第一段）：AI 助手的地址随租户变。 */
export function linkFor(route: string | null | undefined, hostname: string = typeof window === "undefined" ? "" : window.location.hostname): string {
  return (route ?? "#").replace("{code}", hostname.split(".")[0] ?? "");
}

/** 公司自己的 Logo；没有、或图片打不开时显示默认 Logo。 */
function BrandLogo({ logoUrl }: { logoUrl: string | null }) {
  const [failed, setFailed] = React.useState(false);
  if (!logoUrl || failed) return <LogoMark size={36} />;
  return <img src={logoUrl} alt="" width={36} height={36} className="h-9 w-9 shrink-0 rounded-md object-contain" onError={() => setFailed(true)} />;
}

export function MenuTreeShell({
  menus,
  pages,
  label,
  userName,
  brand,
  signOutAction,
  labels,
  headerExtra,
  topExtra,
  homePage,
  profilePage,
}: {
  menus: readonly MenuNode[];
  pages: Record<string, React.ComponentType>;
  label: (node: MenuNode) => string;
  userName: string;
  /** 菜单顶部的品牌：公司简称和 Logo（没有 Logo 用默认的） */
  brand?: { name: string; logoUrl: string | null };
  signOutAction: string;
  /** 顶栏里用户名旁边的内容（消息铃铛） */
  headerExtra?: React.ReactNode;
  /** 顶栏上方的内容（平台横幅） */
  topExtra?: React.ReactNode;
  /** 首页和个人中心页面；不给就没有首页（登录后打开第一个菜单）和个人中心 */
  homePage?: React.ComponentType;
  profilePage?: React.ComponentType;
  labels: ShellLabels;
}) {
  const [tabs, setTabs] = React.useState<TabsState>(() => {
    if (homePage) return openTab(emptyTabs, { id: HOME_ID, title: labels.home ?? "Home", pinned: true });
    const first = firstOpenable(menus);
    return first ? openTab(emptyTabs, { id: first.id, title: label(first) }) : emptyTabs;
  });
  const nav = React.useMemo(
    () => ({
      openPage: (component: string) => {
        const node = findByComponent(menus, component);
        if (!node) return false;
        setTabs((t) => openTab(t, { id: node.id, title: label(node) }));
        return true;
      },
    }),
    [menus, label],
  );
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(new Set());
  // 外链里的 {code} 要用浏览器里的域名；服务端渲染时不知道，所以挂载之后才换（否则服务端和浏览器渲染出的地址不同，React 报水合不一致）
  const [host, setHost] = React.useState<string | null>(null);
  React.useEffect(() => setHost(window.location.hostname), []);

  const active = tabs.activeId ? findMenu(menus, tabs.activeId) : undefined;
  const Page = tabs.activeId === HOME_ID ? homePage : tabs.activeId === PROFILE_ID ? profilePage : active?.component ? pages[active.component] : undefined;

  const [query, setQuery] = React.useState("");
  const [mini, setMini] = React.useState(false); // 只显示图标的窄菜单
  const shown = React.useMemo(() => filterMenus(menus, query, label), [menus, query, label]);
  const searching = query.trim() !== "";

  const toggleDir = (id: string, isCollapsed: boolean) =>
    setCollapsed((c) => { const n = new Set(c); if (isCollapsed) n.delete(id); else n.add(id); return n; });

  // 首页：菜单树最上面的固定入口（和竞品一样），点击切到首页标签；搜索时只在名字匹配时显示
  const homeTitle = labels.home ?? "Home";
  const showHomeItem = !!homePage && (!searching || homeTitle.toLowerCase().includes(query.trim().toLowerCase()));
  const homeActive = tabs.activeId === HOME_ID;
  const openHome = () => setTabs((t) => openTab(t, { id: HOME_ID, title: homeTitle, pinned: true }));

  const renderNode = (node: MenuNode, depth: number): React.ReactNode => {
    if (node.type === "directory") {
      const isCollapsed = !searching && collapsed.has(node.id);
      // 目录：一级目录带图标；子目录缩进
      return (
        <li key={node.id}>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium text-foreground hover:bg-border/40"
            style={{ paddingLeft: 12 + depth * 12 }}
            aria-expanded={!isCollapsed}
            onClick={() => toggleDir(node.id, isCollapsed)}
          >
            {depth === 0 ? <MenuIcon name={node.icon} /> : null}
            <span className="flex-1 truncate">{label(node)}</span>
            {isCollapsed ? <ChevronRight aria-hidden className="h-4 w-4 text-muted" /> : <ChevronDown aria-hidden className="h-4 w-4 text-muted" />}
          </button>
          {!isCollapsed ? (
            <ul className="ml-5 mt-0.5 space-y-0.5 border-l border-border pl-1">{node.children.map((c) => renderNode(c, depth + 1))}</ul>
          ) : null}
        </li>
      );
    }
    if (node.type === "link") {
      return (
        <li key={node.id}>
          <a className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-muted hover:bg-border/40 hover:text-foreground" href={host === null ? "#" : linkFor(node.route, host)} target="_blank" rel="noopener noreferrer">
            <span className="flex-1 truncate">{label(node)}</span>
            <ExternalLink aria-hidden className="h-3.5 w-3.5" />
          </a>
        </li>
      );
    }
    const isActive = tabs.activeId === node.id;
    return (
      <li key={node.id}>
        <button
          type="button"
          aria-current={isActive ? "page" : undefined}
          className={cn(
            "block w-full truncate rounded-md px-3 py-1.5 text-left text-sm text-muted hover:bg-border/40 hover:text-foreground",
            isActive && "bg-primary/10 font-medium text-primary hover:bg-primary/10 hover:text-primary",
          )}
          onClick={() => setTabs((t) => openTab(t, { id: node.id, title: label(node) }))}
        >
          {label(node)}
        </button>
      </li>
    );
  };

  return (
    <NavContext.Provider value={nav}>
    <div className="flex h-screen overflow-hidden">
      {/* 左侧菜单：整列固定在屏幕高度内，菜单自己滚动，不带着右边的内容走 */}
      <nav aria-label="Menu" className={cn("flex shrink-0 flex-col border-r border-border bg-border/10 transition-[width]", mini ? "w-14" : "w-64")}>
        <div className={cn("flex h-14 shrink-0 items-center gap-2 border-b border-border font-semibold", mini ? "justify-center px-2" : "px-4")}>
          <BrandLogo logoUrl={brand?.logoUrl ?? null} />
          {mini ? null : <span className="truncate">{brand?.name ?? "StarIT"}</span>}
        </div>
        {mini ? (
          <ul className="flex-1 space-y-1 overflow-y-auto px-2 py-3">
            {homePage ? (
              <li>
                <button type="button" title={homeTitle} aria-label={homeTitle} aria-current={homeActive ? "page" : undefined} className={cn("flex w-full justify-center rounded-md p-2 text-muted hover:bg-border/40 hover:text-foreground", homeActive && "bg-primary/10 text-primary")} onClick={openHome}>
                  <House aria-hidden className="h-5 w-5" />
                </button>
              </li>
            ) : null}
            {menus.map((m) => (
              <li key={m.id}>
                <button type="button" title={label(m)} aria-label={label(m)} className="flex w-full justify-center rounded-md p-2 text-muted hover:bg-border/40 hover:text-foreground" onClick={() => setMini(false)}>
                  <MenuIcon name={m.icon} className="h-5 w-5" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <div className="relative shrink-0 px-3 pt-3">
              <Search aria-hidden className="pointer-events-none absolute left-5 top-1/2 mt-1.5 h-4 w-4 -translate-y-1/2 text-muted" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={labels.searchMenus ?? "Search menu"}
                aria-label={labels.searchMenus ?? "Search menu"}
                className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-2 text-sm outline-none focus:border-primary"
              />
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-3">
              {menus.length === 0 && !homePage ? <p className="text-sm text-muted">{labels.noMenus}</p> : <ul className="space-y-0.5">
                {showHomeItem ? (
                  <li>
                    <button
                      type="button"
                      aria-current={homeActive ? "page" : undefined}
                      className={cn("flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium text-foreground hover:bg-border/40", homeActive && "bg-primary/10 text-primary hover:bg-primary/10")}
                      onClick={openHome}
                    >
                      <House aria-hidden className="h-4 w-4" />
                      <span className="flex-1 truncate">{homeTitle}</span>
                    </button>
                  </li>
                ) : null}
                {shown.map((m) => renderNode(m, 0))}
              </ul>}
            </div>
          </>
        )}
        <button
          type="button"
          aria-label={mini ? (labels.expandMenu ?? "Expand menu") : (labels.collapseMenu ?? "Collapse menu")}
          title={mini ? (labels.expandMenu ?? "Expand menu") : (labels.collapseMenu ?? "Collapse menu")}
          className="flex shrink-0 items-center justify-center gap-2 border-t border-border py-2 text-sm text-muted hover:text-foreground"
          onClick={() => setMini((v) => !v)}
        >
          {mini ? <PanelLeftOpen aria-hidden className="h-4 w-4" /> : <><PanelLeftClose aria-hidden className="h-4 w-4" />{labels.collapseMenu ?? "Collapse menu"}</>}
        </button>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        {topExtra}
        <header className="flex h-14 shrink-0 items-center justify-end gap-3 border-b border-border px-4 text-sm text-muted">
          {headerExtra}
          <UserMenu
            userName={userName}
            signOutAction={signOutAction}
            labels={{ signedInAs: labels.signedInAs, signOut: labels.signOut, profile: labels.profile, language: labels.language, languageNames: labels.languageNames } satisfies UserMenuLabels}
            onProfile={profilePage ? () => setTabs((t) => openTab(t, { id: PROFILE_ID, title: labels.profile ?? "Profile" })) : undefined}
          />
        </header>
        <TabBar
          state={tabs}
          closeLabel={labels.closeTab}
          onActivate={(id) => setTabs((t) => ({ ...t, activeId: id }))}
          onClose={(id) => setTabs((t) => closeTab(t, id))}
        />
        <main className="min-h-0 flex-1 overflow-y-auto p-4">
          {tabs.activeId === HOME_ID || tabs.activeId === PROFILE_ID || active ? (Page ? <Page /> : <p className="text-sm text-muted">{labels.pageNotBuilt}</p>) : null}
        </main>
      </div>
    </div>
    </NavContext.Provider>
  );
}
