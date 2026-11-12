// 租户只来自访问的主机名：hq.localhost:3001 → "hq"。与后端同一条规则。
export function tenantCodeFromHost(host: string | null | undefined): string | null {
  if (!host) return null;
  const name = host.split(":")[0].toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return null;
  const labels = name.split(".");
  if (labels.length < 2) return null;
  const code = labels[0];
  return code === "platform" ? null : code;
}

export const realmFor = (code: string): string => `tenant-${code}`;

export type Entry = "admin" | "portal";

/** 每个入口对应的 Keycloak 客户端、回调路径（要与域模板里登记的回调地址一致：门户 /*，后台 /admin/*）。 */
export function entryParams(entry: Entry): { clientId: string; base: string } {
  return entry === "admin" ? { clientId: "admin", base: "/admin" } : { clientId: "portal", base: "" };
}

/** 登录后回到哪里：只允许本站内、且在该入口下的路径，防止开放重定向。 */
export function safeReturnPath(value: string | null | undefined, entry: Entry): string {
  const base = entryParams(entry).base;
  const fallback = base || "/";
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  if (base && value !== base && !value.startsWith(`${base}/`) && !value.startsWith(`${base}?`)) return fallback;
  if (value.startsWith("/auth/") || value.startsWith("/admin/auth/") || value.startsWith("/bff/")) return fallback;
  return value;
}
