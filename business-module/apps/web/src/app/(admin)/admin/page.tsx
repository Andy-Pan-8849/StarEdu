import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/admin-shell";
import { callApi } from "@/lib/auth/api-client";
import { webAuthConfig } from "@/lib/auth/config";
import { freshSession, loadSession, SESSION_COOKIE } from "@/lib/auth/server-session";

export const dynamic = "force-dynamic";

// 后台首页：没有登录会话就去登录；有就取"我是谁、我的权限、我的菜单"，交给外壳渲染。
// 每次打开都向后端取最新的（后端的权限有缓存和版本号，很便宜），所以改了角色刷新就生效。
export default async function AdminHome() {
  const config = webAuthConfig();
  const jar = await cookies();
  const live = await loadSession(jar.get(SESSION_COOKIE)?.value, "admin");
  const fresh = live && (await freshSession(live));
  if (!fresh) redirect("/admin/auth/login?return=/admin");

  const host = (await headers()).get("host") ?? "";
  const call = (path: string) => callApi({ apiUrl: config.apiUrl, host, method: "GET", path, token: fresh.session.accessToken });
  const [me, menus] = await Promise.all([call("/api/me"), call("/api/me/menus?entry=admin")]);
  if (me.status === 401 || menus.status === 401) redirect("/admin/auth/login?return=/admin");
  if (me.status !== 200 || menus.status !== 200) throw new Error(`Could not load the menu (${me.status}/${menus.status})`);
  const account = JSON.parse(me.body.toString("utf8")) as { username: string; permissions: string[]; brand?: { name: string; logoUrl: string | null } };
  return <AdminShell menus={JSON.parse(menus.body.toString("utf8"))} permissions={account.permissions} userName={account.username} brand={account.brand} wsPort={new URL(config.apiUrl).port} />;
}
