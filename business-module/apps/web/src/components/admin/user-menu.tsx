"use client";

import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Check, Globe, LogOut, UserRound } from "lucide-react";
import { LOCALES, LOCALE_COOKIE } from "@/i18n/locales";

export interface UserMenuLabels {
  signedInAs: string;
  signOut: string;
  profile?: string;
  language?: string;
  /** 语言名：locale → 显示文字 */
  languageNames?: Record<string, string>;
}

/** 顶栏右侧的头像：点开是"个人中心 / 语言 / 退出登录"。 */
export function UserMenu({ userName, signOutAction, labels, onProfile }: { userName: string; signOutAction: string; labels: UserMenuLabels; onProfile?: () => void }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const locale = useLocale();
  const router = useRouter();
  React.useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  const choose = (next: string) => {
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    setOpen(false);
    router.refresh();
  };
  const initial = (userName.trim()[0] ?? "?").toUpperCase();
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={userName} title={userName} className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-white hover:opacity-90" onClick={() => setOpen((v) => !v)}>
        {initial}
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 top-10 z-30 w-56 overflow-hidden rounded-lg border border-border bg-background py-1 text-sm shadow-lg">
          <div className="border-b border-border px-3 py-2 text-muted">
            {labels.signedInAs} <strong className="text-foreground">{userName}</strong>
          </div>
          {onProfile ? (
            <button type="button" role="menuitem" className="flex w-full items-center gap-2 px-3 py-2 text-left text-foreground hover:bg-border/40" onClick={() => { setOpen(false); onProfile(); }}>
              <UserRound aria-hidden className="h-4 w-4" />
              {labels.profile ?? "Profile"}
            </button>
          ) : null}
          <div className="border-t border-border px-3 py-2">
            <div className="mb-1 flex items-center gap-2 text-muted"><Globe aria-hidden className="h-4 w-4" />{labels.language ?? "Language"}</div>
            {LOCALES.map((l) => (
              <button key={l} type="button" role="menuitemradio" aria-checked={l === locale} className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-foreground hover:bg-border/40" onClick={() => choose(l)}>
                {labels.languageNames?.[l] ?? l}
                {l === locale ? <Check aria-hidden className="h-4 w-4 text-primary" /> : null}
              </button>
            ))}
          </div>
          <form method="post" action={signOutAction} className="border-t border-border">
            <button type="submit" role="menuitem" className="flex w-full items-center gap-2 px-3 py-2 text-left text-foreground hover:bg-border/40">
              <LogOut aria-hidden className="h-4 w-4" />
              {labels.signOut}
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
