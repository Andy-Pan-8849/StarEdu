"use client";

// 顶栏的消息铃铛和平台横幅：未读数、最近的消息、标已读、通知设置；有新消息时通过 WebSocket 即时刷新，断线后自动重连并补拉。
import { useTranslations } from "next-intl";
import * as React from "react";
import { bff } from "@/lib/bff";

interface Item { id: string; title: string; body: string; category: string; createdAt: string; readAt: string | null }
interface Prefs { locale: string | null; categories: Array<{ category: string; inApp: boolean; email: boolean }> }
interface Banner { id: string; title: string; body: string; severity: string }

/** WebSocket 地址：开发时 API 在另一个端口（wsPort），生产里反向代理同域同端口。 */
export function wsUrl(loc: { protocol: string; hostname: string; host: string }, wsPort: string, ticket: string): string {
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${wsPort ? `${loc.hostname}:${wsPort}` : loc.host}/ws?ticket=${ticket}`;
}

export function NotificationBell({ wsPort }: { wsPort: string }) {
  const t = useTranslations("notifications");
  const [items, setItems] = React.useState<Item[]>([]);
  const [unread, setUnread] = React.useState(0);
  const [open, setOpen] = React.useState(false);
  const [settings, setSettings] = React.useState<Prefs | null>(null);

  const load = React.useCallback(() => {
    void bff<{ unread: number; items: Item[] }>("notifications?size=20").then((r) => { setItems(r.items); setUnread(r.unread); }).catch(() => undefined);
  }, []);

  React.useEffect(() => {
    load();
    let closed = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let delay = 1000;
    const connect = () => {
      void bff<{ ticket: string }>("notifications/ws-ticket", { method: "POST" })
        .then(({ ticket }) => {
          if (closed) return;
          ws = new WebSocket(wsUrl(window.location, wsPort, ticket));
          ws.onopen = () => { delay = 1000; load(); }; // 重连后补拉错过的
          ws.onmessage = () => load();
          ws.onclose = () => { if (!closed) retry = setTimeout(connect, (delay = Math.min(delay * 2, 30000))); };
        })
        .catch(() => { if (!closed) retry = setTimeout(connect, (delay = Math.min(delay * 2, 30000))); });
    };
    connect();
    return () => { closed = true; if (retry) clearTimeout(retry); ws?.close(); };
  }, [load, wsPort]);

  async function read(ids?: string[]) {
    await bff("notifications/read", { method: "POST", body: ids ? { ids } : { all: true } });
    load();
  }
  async function toggleSettings() {
    if (settings) return setSettings(null);
    setSettings(await bff<Prefs>("notifications/preferences"));
  }
  async function save(next: Prefs) {
    setSettings(next);
    await bff("notifications/preferences", { method: "PUT", body: { locale: next.locale, prefs: next.categories } });
  }

  return (
    <div className="relative">
      <button type="button" aria-label={t("bell")} aria-expanded={open} className="relative px-2" onClick={() => setOpen(!open)}>
        <span aria-hidden>🔔</span>
        {unread > 0 ? <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] leading-4 text-white">{unread > 99 ? "99+" : unread}</span> : null}
      </button>
      {open ? (
        <div role="dialog" aria-label={t("title")} className="absolute right-0 z-20 mt-1 w-80 rounded-md border border-border bg-background p-2 text-sm shadow">
          <div className="mb-2 flex items-center justify-between">
            <strong>{t("title")}</strong>
            <span className="flex gap-2">
              <button type="button" className="underline" onClick={() => void read()}>{t("markAll")}</button>
              <button type="button" className="underline" onClick={() => void toggleSettings()}>{t("settings")}</button>
            </span>
          </div>
          {settings ? (
            <div className="mb-2 rounded-md border border-border p-2">
              <label className="mb-2 flex items-center gap-2">{t("language")}
                <select className="rounded-md border border-border bg-transparent px-1" value={settings.locale ?? ""} onChange={(e) => void save({ ...settings, locale: e.target.value || null })}>
                  <option value="">{t("auto")}</option><option value="en">English</option><option value="zh">中文</option>
                </select></label>
              <table className="w-full text-left"><thead className="text-muted"><tr><th>{t("category")}</th><th>{t("inApp")}</th><th>{t("email")}</th></tr></thead>
                <tbody>{settings.categories.map((c) => (
                  <tr key={c.category}><td>{t(`cat_${c.category}`)}</td>
                    <td><input type="checkbox" aria-label={`${c.category} in-app`} checked={c.inApp} onChange={(e) => void save({ ...settings, categories: settings.categories.map((x) => (x.category === c.category ? { ...x, inApp: e.target.checked } : x)) })} /></td>
                    <td><input type="checkbox" aria-label={`${c.category} e-mail`} checked={c.email} onChange={(e) => void save({ ...settings, categories: settings.categories.map((x) => (x.category === c.category ? { ...x, email: e.target.checked } : x)) })} /></td></tr>
                ))}</tbody></table>
            </div>
          ) : null}
          <ul className="max-h-80 space-y-1 overflow-auto">
            {items.length === 0 ? <li className="text-muted">{t("empty")}</li> : items.map((n) => (
              <li key={n.id} className={`rounded-md border border-border p-2 ${n.readAt ? "text-muted" : ""}`}>
                <button type="button" className="w-full text-left" onClick={() => !n.readAt && void read([n.id])}>
                  <div className="font-medium">{n.title}</div>
                  {n.body ? <div className="whitespace-pre-wrap">{n.body}</div> : null}
                  <div className="text-xs text-muted">{new Date(n.createdAt).toLocaleString()}</div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function BannerStrip() {
  const [banners, setBanners] = React.useState<Banner[]>([]);
  React.useEffect(() => { void bff<Banner[]>("banners").then(setBanners).catch(() => undefined); }, []);
  if (!banners.length) return null;
  return (
    <div role="status">
      {banners.map((b) => <div key={b.id} className={`px-4 py-1 text-sm ${b.severity === "warning" ? "bg-amber-100 text-amber-900" : "bg-blue-100 text-blue-900"}`}><strong>{b.title}</strong> {b.body}</div>)}
    </div>
  );
}
