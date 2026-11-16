import { isTrialBlocked, trialProtectEnabled } from "./trial-protect";

describe("trial protection rules", () => {
  it("is off unless TRIAL_PROTECT=1", () => {
    expect(trialProtectEnabled({})).toBe(false);
    expect(trialProtectEnabled({ TRIAL_PROTECT: "true" })).toBe(false);
    expect(trialProtectEnabled({ TRIAL_PROTECT: "1" })).toBe(true);
  });

  it("blocks account lifecycle and credential routes for tenants, whatever the trailing slash or case of the method", () => {
    for (const [m, p] of [
      ["POST", "/api/accounts"],
      ["post", "/api/accounts/"],
      ["POST", "/api/accounts/reconcile"],
      ["PATCH", "/api/accounts/abc/status"],
      ["PATCH", "/api/accounts/abc/email"],
      ["POST", "/api/accounts/abc/invite"],
      ["POST", "/api/accounts/abc/reset-link"],
      ["POST", "/api/accounts/abc/temp-password"],
      ["POST", "/api/accounts/abc/unlock"],
    ]) expect(isTrialBlocked("tenant", m, p)).toBe(true);
  });

  it("leaves everything a visitor should try open for tenants", () => {
    for (const [m, p] of [
      ["GET", "/api/accounts"],
      ["PUT", "/api/accounts/abc/roles"],
      ["POST", "/api/roles"],
      ["POST", "/api/auth/session"],
      ["POST", "/api/majors"],
      ["POST", "/api/requests/abc/decide"],
      ["POST", "/api/library/folders/abc/uploads"],
    ]) expect(isTrialBlocked("tenant", m, p)).toBe(false);
  });

  it("blocks tenant provisioning, status, admin credentials, security and platform accounts on the platform, and keeps the rest", () => {
    for (const [m, p] of [
      ["POST", "/api/platform/tenants"],
      ["PATCH", "/api/platform/tenants/abc"],
      ["POST", "/api/platform/tenants/abc/status"],
      ["POST", "/api/platform/tenants/abc/admin/reset-password"],
      ["PATCH", "/api/platform/tenants/abc/admin/email"],
      ["PUT", "/api/platform/tenants/abc/security"],
      ["DELETE", "/api/platform/tenants/abc/security/google"],
      ["POST", "/api/platform/accounts"],
      ["PATCH", "/api/platform/accounts/abc/status"],
      ["PUT", "/api/platform/accounts/abc/roles"],
      ["DELETE", "/api/platform/roles/abc"],
      ["PATCH", "/api/platform/menus/abc"],
      ["PUT", "/api/platform/entries/admin/menus"],
    ]) expect(isTrialBlocked("platform", m, p)).toBe(true);
    for (const [m, p] of [
      ["GET", "/api/platform/tenants"],
      ["PUT", "/api/platform/tenants/abc/grants"],
      ["PUT", "/api/platform/tenants/abc/quota"],
      ["POST", "/api/platform/jobs/abc/run"],
      ["POST", "/api/platform/auth/session"],
    ]) expect(isTrialBlocked("platform", m, p)).toBe(false);
  });

  it("platform rules do not apply to tenants and the reverse", () => {
    expect(isTrialBlocked("tenant", "POST", "/api/platform/tenants")).toBe(false);
    expect(isTrialBlocked("platform", "POST", "/api/accounts")).toBe(false);
  });
});
