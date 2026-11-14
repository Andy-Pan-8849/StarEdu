import { afterEach, describe, expect, it, vi } from "vitest";
import { oidcFor } from "@/lib/config";

describe("oidcFor", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses the single realm when business mode is off (the standalone behaviour)", () => {
    expect(oidcFor("anything.example.com")).toEqual({
      authority: "http://localhost:8080/realms/starit",
      clientId: "starit-web",
    });
  });

  it("picks the company's realm from the first label of the address", () => {
    vi.stubEnv("NEXT_PUBLIC_TENANT_REALM_BASE", "http://localhost:8180/realms/");
    expect(oidcFor("hq.localhost")).toEqual({
      authority: "http://localhost:8180/realms/tenant-hq",
      clientId: "ai",
    });
    expect(oidcFor("riverside-franchise.localhost")).toEqual({
      authority: "http://localhost:8180/realms/tenant-riverside-franchise",
      clientId: "ai",
    });
  });

  it("refuses an address that is not a company's (no realm is guessed)", () => {
    vi.stubEnv("NEXT_PUBLIC_TENANT_REALM_BASE", "http://localhost:8180/realms");
    expect(() => oidcFor("localhost")).toThrow(/company/);
    expect(() => oidcFor("HQ.example.com")).toThrow(/company/);
    expect(() => oidcFor("../evil.example.com")).toThrow(/company/);
  });
});
