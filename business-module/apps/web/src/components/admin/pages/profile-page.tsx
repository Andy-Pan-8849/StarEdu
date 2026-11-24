"use client";

// 个人中心：我是谁（姓名、账号、角色、所属部门，由教务/人事维护，只读）、我能自己改的联系方式（手机、邮箱）、修改密码。
// 密码在统一身份系统（Keycloak）里：点按钮跳过去改，改完回到这里；强度、历史等规则都由它负责。
import { useTranslations } from "next-intl";
import * as React from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { bff } from "@/lib/bff";
import { Tabs } from "../tabs";

interface Profile { username: string; fullName: string | null; type: string | null; number: string | null; email: string | null; phone: string | null; roles: Array<{ code: string; name: string }>; depts: string[]; createdAt: string; editable: boolean }

const input = "rounded-md border border-border bg-transparent px-2 py-1";

/** 改密码入口：登录流程加上"改密码"动作，改完正常登录回到当前入口。 */
export function passwordChangeHref(pathname: string): string {
  const admin = pathname.startsWith("/admin");
  return `${admin ? "/admin" : ""}/auth/login?kc_action=password&return=${encodeURIComponent(admin ? "/admin" : "/")}`;
}

export function ProfilePage() {
  const t = useTranslations("profile");
  const c = useTranslations("crud");
  const [p, setP] = React.useState<Profile | null>(null);
  const [tab, setTab] = React.useState<"basic" | "password">("basic");
  const [phone, setPhone] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [msg, setMsg] = React.useState<{ text: string; error: boolean } | null>(null);
  React.useEffect(() => {
    void bff<Profile>("me/profile").then((r) => { setP(r); setPhone(r.phone ?? ""); setEmail(r.email ?? ""); }).catch((e: Error) => setMsg({ text: e.message, error: true }));
  }, []);
  if (!p) return msg ? <p role="alert" className="text-sm text-red-600">{msg.text}</p> : <p className="text-sm text-muted">…</p>;

  async function save() {
    try {
      const r = await bff<{ phone: string | null; email: string | null }>("me/profile", { method: "PATCH", body: { phone: phone.trim() || null, workEmail: email.trim() || null } });
      setP((x) => (x ? { ...x, phone: r.phone, email: r.email } : x));
      setMsg({ text: c("saved"), error: false });
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  }
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex gap-3 py-1.5"><dt className="w-24 shrink-0 text-muted">{label}</dt><dd>{value || "—"}</dd></div>
  );
  return (
    <div className="grid gap-4 text-sm lg:grid-cols-[18rem_1fr]">
      <aside className="rounded-lg border border-border p-4">
        <div className="mb-3 flex items-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary text-xl font-semibold text-white">{((p.fullName ?? p.username)[0] ?? "?").toUpperCase()}</div>
          <div>
            <div className="text-base font-semibold">{p.fullName ?? p.username}</div>
            <div className="text-muted">{p.username}</div>
          </div>
        </div>
        <dl className="divide-y divide-border">
          {row(t("number"), p.number)}
          {row(t("roles"), p.roles.map((r) => r.name).join(", "))}
          {row(t("depts"), p.depts.join(", "))}
          {row(t("joined"), new Date(p.createdAt).toLocaleDateString())}
        </dl>
      </aside>
      <section className="rounded-lg border border-border p-4">
        <Tabs value={tab} onChange={setTab} items={[{ key: "basic", label: t("tabBasic") }, { key: "password", label: t("tabPassword") }]} />
        {tab === "basic" ? (
          <div className="flex max-w-md flex-col gap-3">
            {msg ? <p role={msg.error ? "alert" : "status"} className={msg.error ? "text-red-600" : "text-muted"}>{msg.text}</p> : null}
            <p className="text-muted">{t("basicNote")}</p>
            <label className="flex flex-col gap-1">{t("phone")}<input className={input} value={phone} disabled={!p.editable} onChange={(e) => setPhone(e.target.value)} /></label>
            <label className="flex flex-col gap-1">{t("email")}<input type="email" className={input} value={email} disabled={!p.editable} onChange={(e) => setEmail(e.target.value)} /></label>
            {p.editable ? <div><Button size="sm" onClick={() => void save()}>{c("save")}</Button></div> : <p className="text-muted">{t("noProfile")}</p>}
          </div>
        ) : (
          <div className="flex max-w-md flex-col gap-3">
            <p className="text-muted">{t("passwordNote")}</p>
            <div>
              <a className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 hover:border-primary hover:text-primary" href={passwordChangeHref(typeof window === "undefined" ? "/" : window.location.pathname)}>
                <KeyRound aria-hidden className="h-4 w-4" />
                {t("changePassword")}
              </a>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
