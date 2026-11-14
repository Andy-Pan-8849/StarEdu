import { describe, expect, it } from "vitest";
import { accountsWouldExceed, BYTES_PER_MB, meter, quotaProblems, storageWouldExceed } from "./quota";

describe("quota", () => {
  it("meter reports percent, full and over; no limit means never full", () => {
    expect(meter(5, null)).toEqual({ used: 5, limit: null, percent: null, full: false, over: false });
    expect(meter(5, 10)).toMatchObject({ percent: 50, full: false, over: false });
    expect(meter(10, 10)).toMatchObject({ percent: 100, full: true, over: false });
    expect(meter(12, 10)).toMatchObject({ percent: 120, full: true, over: true });
  });
  it("accountsWouldExceed", () => {
    expect(accountsWouldExceed(9, 10)).toBe(false);
    expect(accountsWouldExceed(10, 10)).toBe(true);
    expect(accountsWouldExceed(9, 10, 2)).toBe(true);
    expect(accountsWouldExceed(1000, null)).toBe(false);
  });
  it("storageWouldExceed counts bytes against MB", () => {
    expect(storageWouldExceed(0, 1, BYTES_PER_MB)).toBe(false);
    expect(storageWouldExceed(0, 1, BYTES_PER_MB + 1)).toBe(true);
    expect(storageWouldExceed(BYTES_PER_MB, 1, 1)).toBe(true);
    expect(storageWouldExceed(10 ** 12, null, 10 ** 12)).toBe(false);
  });
  it("quotaProblems", () => {
    expect(quotaProblems({ maxAccounts: null, maxStorageMb: null })).toEqual([]);
    expect(quotaProblems({ maxAccounts: 50, maxStorageMb: 1024 })).toEqual([]);
    expect(quotaProblems({ maxAccounts: 0, maxStorageMb: null })).toHaveLength(1);
    expect(quotaProblems({ maxAccounts: 1.5, maxStorageMb: -3 })).toHaveLength(2);
  });
});
