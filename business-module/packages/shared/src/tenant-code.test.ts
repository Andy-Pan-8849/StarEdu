import { describe, expect, it } from "vitest";
import { checkTenantCode, RESERVED_TENANT_CODES } from "./tenant-code";

describe("checkTenantCode", () => {
  it("accepts ordinary codes", () => {
    for (const code of ["hq", "franchise", "star-it-2", "abc"]) {
      expect(checkTenantCode(code)).toBeNull();
    }
  });

  it("rejects every reserved word", () => {
    for (const code of RESERVED_TENANT_CODES) {
      const problem = checkTenantCode(code);
      expect(problem === "reserved" || problem === "format").toBe(true);
    }
    expect(checkTenantCode("platform")).toBe("reserved");
    expect(checkTenantCode("admin")).toBe("reserved");
  });

  it("rejects bad formats", () => {
    for (const code of ["", "a", "Ab1", "1abc", "ab_c", "abc-", "-abc", "a".repeat(31), "a b c", "中文代码"]) {
      expect(checkTenantCode(code)).toBe("format");
    }
    expect(checkTenantCode("a--b")).toBe("double-hyphen");
  });
});
