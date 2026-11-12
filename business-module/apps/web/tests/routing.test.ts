import { describe, expect, it } from "vitest";
import { isPlatformHost, rewriteTarget } from "../src/lib/route-for-host";
import { DEFAULT_LOCALE, resolveLocale } from "../src/i18n/locales";

describe("rewriteTarget (which entry a host and path belong to)", () => {
  it("leaves tenant hosts alone: / is the portal, /admin the back office", () => {
    expect(rewriteTarget("hq.localhost:3001", "/")).toBeNull();
    expect(rewriteTarget("hq.localhost:3001", "/admin")).toBeNull();
    expect(rewriteTarget("franchise.staredu.com", "/admin/users")).toBeNull();
  });

  it("maps the platform host to /platform", () => {
    expect(rewriteTarget("platform.localhost:3001", "/")).toBe("/platform");
    expect(rewriteTarget("platform.staredu.com", "/tenants")).toBe("/platform/tenants");
  });

  it("does not rewrite twice", () => {
    expect(rewriteTarget("platform.localhost:3001", "/platform")).toBeNull();
    expect(rewriteTarget("platform.localhost:3001", "/platform/tenants")).toBeNull();
  });

  it("only the exact label 'platform' counts as the platform host", () => {
    expect(isPlatformHost("platform.localhost:3001")).toBe(true);
    expect(isPlatformHost("platformer.localhost:3001")).toBe(false);
    expect(isPlatformHost("hq.platform.example.com")).toBe(false);
    expect(isPlatformHost(null)).toBe(false);
  });
});

describe("resolveLocale", () => {
  it("defaults to English and ignores unknown values", () => {
    expect(resolveLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(resolveLocale("fr")).toBe("en");
    expect(resolveLocale("zh")).toBe("zh");
  });
});
