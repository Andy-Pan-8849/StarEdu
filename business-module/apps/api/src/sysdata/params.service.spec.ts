import { paramProblem } from "./params.service";

describe("paramProblem", () => {
  it("accepts values in range and rejects the rest for known keys", () => {
    expect(paramProblem("edu.appeal.windowDays", "30")).toBeNull();
    expect(paramProblem("edu.appeal.windowDays", "0")).toMatch(/between 1 and 90/);
    expect(paramProblem("edu.appeal.windowDays", "ten")).toMatch(/whole number/);
    expect(paramProblem("system.list.pageSize", "500")).not.toBeNull();
    expect(paramProblem("system.ui.defaultLocale", "zh")).toBeNull();
    expect(paramProblem("system.ui.defaultLocale", "fr")).toMatch(/one of/);
  });
  it("does not validate a tenant's own free-form keys", () => {
    expect(paramProblem("school.openHour", "anything")).toBeNull();
  });
});
