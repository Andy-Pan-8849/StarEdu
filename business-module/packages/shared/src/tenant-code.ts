// 租户代码：登录网址 `<代码>.staredu.com` 的第一段，开通后不可修改（11 号文档 A5）。

/** 保留字：不能作为租户代码（会和平台自己的网址冲突）。 */
export const RESERVED_TENANT_CODES: readonly string[] = [
  "www",
  "admin",
  "platform",
  "api",
  "login",
  "auth",
  "sso",
  "keycloak",
  "static",
  "assets",
  "cdn",
  "mail",
  "smtp",
  "app",
  "portal",
  "docs",
  "status",
  "support",
  "help",
  "staredu",
];

// 小写字母开头，只含小写字母、数字、连字符，不以连字符结尾，2–30 个字符（域名一段最长 63）。
const TENANT_CODE_PATTERN = /^[a-z][a-z0-9-]{0,28}[a-z0-9]$/;

export type TenantCodeProblem = "format" | "reserved" | "double-hyphen";

/** 返回 null 表示可用；否则说明问题类型。 */
export function checkTenantCode(code: string): TenantCodeProblem | null {
  if (!TENANT_CODE_PATTERN.test(code)) return "format";
  if (code.includes("--")) return "double-hyphen";
  if (RESERVED_TENANT_CODES.includes(code)) return "reserved";
  return null;
}
