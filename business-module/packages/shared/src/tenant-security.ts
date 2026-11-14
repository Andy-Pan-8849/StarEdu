// 租户"登录与安全"：把 Keycloak 域里的几项设置读成一个对象，再把对象的修改写回域。
// 纯函数，不访问网络，可单元测试。平台入口的租户管理页签通过 API 使用它；
// 域模板（realm.ts / realm-config.json）仍是新租户的默认值，这里只是"事后调整某个租户"。
export interface TenantSecurity {
  password: { length: number; upperCase: number; lowerCase: number; digits: number; specialChars: number; history: number };
  lockout: { failureFactor: number; waitIncrementMinutes: number; maxWaitMinutes: number; permanent: boolean };
  session: { idleMinutes: number; maxHours: number };
  /** off：和默认一样（用户自己设置了验证器才问）；all：所有人登录都要验证器（没设置的第一次登录时被要求设置） */
  mfa: "off" | "all";
}

export const SECURITY_LIMITS = {
  length: [8, 64],
  classCount: [0, 4],
  history: [0, 10],
  failureFactor: [3, 20],
  waitIncrementMinutes: [1, 60],
  maxWaitMinutes: [1, 1440],
  idleMinutes: [5, 720],
  maxHours: [1, 72],
} as const;

type Realm = Record<string, unknown>;

/** 解析 `length(10) and upperCase(1) and notUsername ...`：键 → 数字（没有括号的项记为 true）。 */
export function parsePasswordPolicy(policy: string | undefined): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (const part of (policy ?? "").split(" and ")) {
    const m = /^\s*([A-Za-z]+)(?:\((.*)\))?\s*$/.exec(part);
    if (m) out.set(m[1], m[2] === undefined ? true : m[2]);
  }
  return out;
}

const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** 流程里"OTP Form"一项的要求：REQUIRED 就是所有人都要验证器。 */
export function mfaFromOtpRequirement(requirement: string | undefined): "off" | "all" {
  return requirement === "REQUIRED" ? "all" : "off";
}

export function securityFromRealm(realm: Realm, mfa: "off" | "all"): TenantSecurity {
  const p = parsePasswordPolicy(realm.passwordPolicy as string | undefined);
  const n = (k: string) => Number(p.get(k) ?? 0) || 0;
  return {
    password: { length: n("length"), upperCase: n("upperCase"), lowerCase: n("lowerCase"), digits: n("digits"), specialChars: n("specialChars"), history: n("passwordHistory") },
    lockout: {
      failureFactor: num(realm.failureFactor, 5),
      waitIncrementMinutes: Math.round(num(realm.waitIncrementSeconds, 600) / 60),
      maxWaitMinutes: Math.round(num(realm.maxFailureWaitSeconds, 3600) / 60),
      permanent: realm.permanentLockout === true,
    },
    session: { idleMinutes: Math.round(num(realm.ssoSessionIdleTimeout, 1800) / 60), maxHours: Math.round(num(realm.ssoSessionMaxLifespan, 36000) / 3600) },
    mfa,
  };
}

/** 设置有问题就返回说明（空数组 = 合法）。 */
export function securityProblems(s: TenantSecurity): string[] {
  const out: string[] = [];
  const within = (label: string, v: number, [lo, hi]: readonly [number, number]) => {
    if (!Number.isInteger(v) || v < lo || v > hi) out.push(`${label} must be a whole number from ${lo} to ${hi}`);
  };
  within("Password length", s.password.length, SECURITY_LIMITS.length);
  for (const k of ["upperCase", "lowerCase", "digits", "specialChars"] as const) within(`Password ${k}`, s.password[k], SECURITY_LIMITS.classCount);
  within("Password history", s.password.history, SECURITY_LIMITS.history);
  within("Failed attempts before lockout", s.lockout.failureFactor, SECURITY_LIMITS.failureFactor);
  within("Lockout wait (minutes)", s.lockout.waitIncrementMinutes, SECURITY_LIMITS.waitIncrementMinutes);
  within("Longest lockout (minutes)", s.lockout.maxWaitMinutes, SECURITY_LIMITS.maxWaitMinutes);
  within("Idle sign-out (minutes)", s.session.idleMinutes, SECURITY_LIMITS.idleMinutes);
  within("Longest session (hours)", s.session.maxHours, SECURITY_LIMITS.maxHours);
  if (s.password.upperCase + s.password.lowerCase + s.password.digits + s.password.specialChars > s.password.length) out.push("The required character classes do not fit in the password length");
  if (s.lockout.maxWaitMinutes < s.lockout.waitIncrementMinutes) out.push("The longest lockout cannot be shorter than the lockout wait");
  if (s.session.idleMinutes > s.session.maxHours * 60) out.push("Idle sign-out cannot be longer than the longest session");
  return out;
}

/** 新的密码策略字符串：改我们管的几项，其余（不得含用户名/邮箱、弱密码黑名单等）原样保留。 */
export function passwordPolicyFrom(current: string | undefined, pw: TenantSecurity["password"]): string {
  const kept = parsePasswordPolicy(current);
  const managed = new Set(["length", "upperCase", "lowerCase", "digits", "specialChars", "passwordHistory"]);
  const parts = [`length(${pw.length})`, `upperCase(${pw.upperCase})`, `lowerCase(${pw.lowerCase})`, `digits(${pw.digits})`, `specialChars(${pw.specialChars})`];
  if (pw.history > 0) parts.push(`passwordHistory(${pw.history})`);
  for (const [k, v] of kept) if (!managed.has(k)) parts.push(v === true ? k : `${k}(${v})`);
  return parts.join(" and ");
}

/** 把设置合并进域定义（返回新对象；没有被我们管的字段原样保留）。 */
export function applySecurityToRealm(realm: Realm, s: TenantSecurity): Realm {
  return {
    ...realm,
    passwordPolicy: passwordPolicyFrom(realm.passwordPolicy as string | undefined, s.password),
    bruteForceProtected: true,
    failureFactor: s.lockout.failureFactor,
    waitIncrementSeconds: s.lockout.waitIncrementMinutes * 60,
    maxFailureWaitSeconds: s.lockout.maxWaitMinutes * 60,
    permanentLockout: s.lockout.permanent,
    ssoSessionIdleTimeout: s.session.idleMinutes * 60,
    ssoSessionMaxLifespan: s.session.maxHours * 3600,
  };
}

// ---- Google 登录（Keycloak 身份代理）----
export const GOOGLE_ALIAS = "google";
/** 只关联已有账号：先找邮箱相同的已有用户，找到就自动关联；找不到就拒绝（不新建账号）。 */
export const LINK_ONLY_FLOW_ALIAS = "existing-account-only";

export interface GoogleStatus {
  configured: boolean;
  enabled: boolean;
  clientId: string | null;
  hasSecret: boolean;
  /** 要在 Google 控制台登记的回调地址 */
  redirectUri: string;
}

export function googleRedirectUri(keycloakPublicUrl: string, realm: string): string {
  return `${keycloakPublicUrl.replace(/\/$/, "")}/realms/${realm}/broker/${GOOGLE_ALIAS}/endpoint`;
}

/** Google 身份提供商的定义（密钥只在写入时给，读出来 Keycloak 返回 ********）。 */
export function googleProvider(input: { clientId: string; clientSecret: string; enabled: boolean }): Record<string, unknown> {
  return {
    alias: GOOGLE_ALIAS,
    displayName: "Google",
    providerId: "google",
    enabled: input.enabled,
    trustEmail: true, // Google 只给已验证的邮箱；自动关联靠它
    storeToken: false,
    addReadTokenRoleOnCreate: false,
    firstBrokerLoginFlowAlias: LINK_ONLY_FLOW_ALIAS,
    config: { clientId: input.clientId, clientSecret: input.clientSecret, syncMode: "IMPORT", defaultScope: "openid email profile", userIp: "false", hostedDomain: "" },
  };
}
