import { describe, expect, it } from "vitest";
import { applySecurityToRealm, googleProvider, googleRedirectUri, mfaFromOtpRequirement, parsePasswordPolicy, passwordPolicyFrom, securityFromRealm, securityProblems, type TenantSecurity } from "./tenant-security";
import { buildRealm } from "./realm";

const realm = buildRealm({ kind: "tenant", code: "hq", displayName: "x", tenantId: "t", webOrigin: "http://hq.localhost:3001", smtp: { host: "m", port: 1, from: "a@b.c", fromDisplayName: "S" } }) as Record<string, unknown>;

describe("tenant security", () => {
  it("reads the template defaults back", () => {
    const s = securityFromRealm(realm, "off");
    expect(s.password).toEqual({ length: 10, upperCase: 1, lowerCase: 1, digits: 1, specialChars: 1, history: 2 });
    expect(s.lockout).toEqual({ failureFactor: 5, waitIncrementMinutes: 10, maxWaitMinutes: 60, permanent: false });
    expect(s.session).toEqual({ idleMinutes: 30, maxHours: 10 });
    expect(securityProblems(s)).toEqual([]);
  });

  it("changes only what it manages and keeps the rest of the realm and the policy", () => {
    const s = securityFromRealm(realm, "off");
    const next = applySecurityToRealm(realm, { ...s, password: { ...s.password, length: 14, history: 0 }, session: { idleMinutes: 60, maxHours: 12 } });
    expect(next.passwordPolicy).toBe("length(14) and upperCase(1) and lowerCase(1) and digits(1) and specialChars(1) and notUsername and notEmail and passwordBlacklist(common-weak.txt)");
    expect(next.ssoSessionIdleTimeout).toBe(3600);
    expect(next.ssoSessionMaxLifespan).toBe(43200);
    expect(next.clients).toBe(realm.clients);
    expect(next.accessTokenLifespan).toBe(realm.accessTokenLifespan);
  });

  it("rejects out-of-range and inconsistent settings", () => {
    const ok = securityFromRealm(realm, "off");
    const bad = (over: Partial<TenantSecurity>) => securityProblems({ ...ok, ...over });
    expect(bad({ password: { ...ok.password, length: 4 } }).length).toBeGreaterThan(0);
    expect(bad({ password: { ...ok.password, length: 8, upperCase: 3, lowerCase: 3, digits: 2, specialChars: 2 } })).toContain("The required character classes do not fit in the password length");
    expect(bad({ lockout: { ...ok.lockout, failureFactor: 1 } }).length).toBeGreaterThan(0);
    expect(bad({ lockout: { ...ok.lockout, waitIncrementMinutes: 30, maxWaitMinutes: 10 } })).toContain("The longest lockout cannot be shorter than the lockout wait");
    expect(bad({ session: { idleMinutes: 600, maxHours: 5 } })).toContain("Idle sign-out cannot be longer than the longest session");
    expect(bad({ session: { idleMinutes: 1.5, maxHours: 5 } }).length).toBeGreaterThan(0);
  });

  it("parses and rebuilds policy strings", () => {
    expect([...parsePasswordPolicy("length(8) and notUsername").entries()]).toEqual([["length", "8"], ["notUsername", true]]);
    expect(passwordPolicyFrom(undefined, { length: 8, upperCase: 0, lowerCase: 0, digits: 0, specialChars: 0, history: 0 })).toBe("length(8) and upperCase(0) and lowerCase(0) and digits(0) and specialChars(0)");
  });

  it("mfa mode follows the OTP form requirement", () => {
    expect(mfaFromOtpRequirement("REQUIRED")).toBe("all");
    expect(mfaFromOtpRequirement("ALTERNATIVE")).toBe("off");
  });

  it("google provider links to existing accounts only and trusts the verified email", () => {
    const p = googleProvider({ clientId: "id", clientSecret: "s", enabled: true }) as { alias: string; trustEmail: boolean; firstBrokerLoginFlowAlias: string };
    expect(p.alias).toBe("google");
    expect(p.trustEmail).toBe(true);
    expect(p.firstBrokerLoginFlowAlias).toBe("existing-account-only");
    expect(googleRedirectUri("https://id.example.test/", "tenant-hq")).toBe("https://id.example.test/realms/tenant-hq/broker/google/endpoint");
  });
});
