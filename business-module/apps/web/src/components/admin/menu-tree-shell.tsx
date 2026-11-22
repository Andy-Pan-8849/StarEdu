"use client";

// 管理后台外壳：左侧菜单树 + 顶部标签页 + 内容区（竞品式布局）。
//   - 目录可展开；"菜单"点击在标签页打开；"外链"在新窗口打开（租户自己的网址）；
//   - 页面组件是构建时打包的：按菜单的"组件路径"在 pages 里找；还没有的显示占位说明，不报错。
import * as React from "react";
import { cn } from "@/lib/utils";
import { LogoMark } from "../logo-mark";
import { firstOpenable, findMenu, type MenuNode } from "./menu-nav";
import { TabBar } from "./tab-bar";
import { closeTab, emptyTabs, openTab, type TabsState } from "./tabs-state";

export interface ShellLabels {
  closeTab: string;
  noMenus: string;
  pageNotBuilt: string;
  signedInAs: string;
  signOut: string;
}

/** 外链里的 {code} 换成当前租户代码（域名第一段）：AI 助手的地址随租户变。 */
export function linkFor(route: string | null | undefined, hostname: string = typeof window === "undefined" ? "" : window.location.hostname): string {
  return (route ?? "#").replace("{code}", hostname.split(".")[0] ?? "");
}

export function MenuTreeShell({
  menus,
  pages,
  label,
  userName,
  signOutAction,
  labels,
  headerExtra,
  topExtra,
}: {
  menus: readonly MenuNode[];
  pages: Record<string, React.ComponentType>;
  label: (node: MenuNode) => string;
  userName: string;
  signOutAction: string;
  /** 顶栏里用户名旁边的内容（消息铃铛） */
  headerExtra?: React.ReactNode;
  /** 顶栏上方的内容（平台横幅） */
  topExtra?: React.ReactNode;
  labels: ShellLabels;
}) {
  const [tabs, setTabs] = React.useState<TabsState>(() => {
    const first = firstOpenable(menus);
    return first ? openTab(emptyTabs, { id: first.id, title: label(first) }) : emptyTabs;
  });
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(new Set());
  // 外链里的 {code} 要用浏览器里的域名；服务端渲染时不知道，所以挂载之后才换（否则服务端和浏览器渲染出的地址不同，React 报水合不一致）
  const [host, setHost] = React.useState<string | null>(null);
  React.useEffect(() => setHost(window.location.hostname), []);

  const active = tabs.activeId ? findMenu(menus, tabs.activeId) : undefined;
  const Page = active?.component ? pages[active.component] : undefined;

  const renderNode = (node: MenuNode, depth: number): React.ReactNode => {
    const pad = { paddingLeft: 12 + depth * 14 };
    if (node.type === "directory") {
      const isCollapsed = collapsed.has(node.id);
      return (
        <li key={node.id}>
          <button
            type="button"
            className="flex w-full items-center justify-between py-1.5 pr-3 text-left text-sm font-medium"
            style={pad}
            aria-expanded={!isCollapsed}
            onClick={() => setCollapsed((c) => { const n = new Set(c); if (isCollapsed) n.delete(node.id); else n.add(node.id); return n; })}
          >
            {label(node)}
            <span aria-hidden className="text-xs text-muted">{isCollapsed ? "▸" : "▾"}</span>
          </button>
          {!isCollapsed ? <ul>{node.children.map((c) => renderNode(c, depth + 1))}</ul> : null}
        </li>
      );
    }
    if (node.type === "link") {
      return (
        <li key={node.id}>
          <a className="block py-1.5 pr-3 text-sm text-muted hover:text-foreground" style={pad} href={host === null ? "#" : linkFor(node.route, host)} target="_blank" rel="noopener noreferrer">
            {label(node)} ↗
          </a>
        </li>
      );
    }
    return (
      <li key={node.id}>
        <button
          type="button"
          className={cn("block w-full py-1.5 pr-3 text-left text-sm hover:bg-border/40", tabs.activeId === node.id && "bg-border/40 font-medium text-primary")}
          style={pad}
          onClick={() => setTabs((t) => openTab(t, { id: node.id, title: label(node) }))}
        >
          {label(node)}
        </button>
      </li>
    );
  };

  return (
    <div className="flex min-h-screen">
      <nav aria-label="Menu" className="w-60 shrink-0 border-r border-border py-3">
        <div className="mb-2 flex items-center gap-2 px-3 pb-3 font-semibold">
          <LogoMark size={36} />
          <span>StarIT</span>
        </div>
        {menus.length === 0 ? <p className="px-3 text-sm text-muted">{labels.noMenus}</p> : <ul>{menus.map((m) => renderNode(m, 0))}</ul>}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        {topExtra}
        <header className="flex items-center justify-end gap-3 border-b border-border px-4 py-2 text-sm text-muted">
          {headerExtra}
          <span>
            {labels.signedInAs} <strong className="text-foreground">{userName}</strong>
          </span>
          <form method="post" action={signOutAction}>
            <button type="submit" className="underline">
              {labels.signOut}
            </button>
          </form>
        </header>
        <TabBar
          state={tabs}
          closeLabel={labels.closeTab}
          onActivate={(id) => setTabs((t) => ({ ...t, activeId: id }))}
          onClose={(id) => setTabs((t) => closeTab(t, id))}
        />
        <main className="flex-1 p-4">
          {active ? (Page ? <Page /> : <p className="text-sm text-muted">{labels.pageNotBuilt}</p>) : null}
        </main>
      </div>
    </div>
  );
}
