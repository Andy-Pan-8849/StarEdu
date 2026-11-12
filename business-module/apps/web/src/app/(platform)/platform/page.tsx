import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/admin-shell";
import { callApi } from "@/lib/auth/api-client";
import { webAuthConfig } from "@/lib/auth/config";
import { freshSession, loadSession, SESSION_COOKIE } from "@/lib/auth/server-session";

export const dynamic = "force-dynamic";

// 平台入口首页（主机名 platform.* 在中间件里改写到这里）：没有会话就去平台域登录，有就取我的权限和菜单交给外壳。
export default async function PlatformHome() {
  const config = webAuthConfig();
  const jar = await cookies();
  const live = await loadSession(jar.get(SESSION_COOKIE)?.value, "platform");
  const fresh = live && (await freshSession(live));
  if (!fresh) redirect("/auth/login?return=/");

  const host = (await headers()).get("host") ?? "";
  const call = (path: string) => callApi({ apiUrl: config.apiUrl, host, method: "GET", path, token: fresh.session.accessToken });
  const [me, menus] = await Promise.all([call("/api/platform/me"), call("/api/platform/me/menus")]);
  if (me.status === 401 || menus.status === 401) redirect("/auth/login?return=/");
  if (me.status !== 200 || menus.status !== 200) throw new Error(`Could not load the menu (${me.status}/${menus.status})`);
  const account = JSON.parse(me.body.toString("utf8")) as { username: string; permissions: string[] };
  return <AdminShell menus={JSON.parse(menus.body.toString("utf8"))} permissions={account.permissions} userName={account.username} signOutAction="/auth/logout" />;
}
