import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/admin-shell";
import { callApi } from "@/lib/auth/api-client";
import { webAuthConfig } from "@/lib/auth/config";
import { freshSession, loadSession, SESSION_COOKIE } from "@/lib/auth/server-session";

export const dynamic = "force-dynamic";

// 学生门户首页：没有登录会话就去登录；有就取"我是谁、我的菜单"，交给外壳渲染（同一个外壳，菜单不同）。
export default async function PortalHome() {
  const config = webAuthConfig();
  const jar = await cookies();
  const live = await loadSession(jar.get(SESSION_COOKIE)?.value, "portal");
  const fresh = live && (await freshSession(live));
  if (!fresh) redirect("/auth/login?return=/");

  const host = (await headers()).get("host") ?? "";
  const call = (path: string) => callApi({ apiUrl: config.apiUrl, host, method: "GET", path, token: fresh.session.accessToken });
  const [me, menus] = await Promise.all([call("/api/me"), call("/api/me/menus?entry=portal")]);
  if (me.status === 401 || menus.status === 401) redirect("/auth/login?return=/");
  if (me.status !== 200 || menus.status !== 200) throw new Error(`Could not load the menu (${me.status}/${menus.status})`);
  const account = JSON.parse(me.body.toString("utf8")) as { username: string; permissions: string[] };
  return <AdminShell menus={JSON.parse(menus.body.toString("utf8"))} permissions={account.permissions} userName={account.username} signOutAction="/auth/logout" />;
}
