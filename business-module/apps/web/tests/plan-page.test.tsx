// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { PermissionProvider } from "../src/components/admin/permissions";

const base = {
  majors: [{ id: "m1", name: "Java Programming", kind: "primary" }, { id: "m2", name: "Minor Math", kind: "minor" }],
  credits: { earned: 3, required: 9 },
  categories: [{ category: "required", earned: 3, planned: 6 }, { category: "elective", earned: 0, planned: 3 }],
  elective: { earned: 0, min: 3 },
};
const primary = {
  ...base,
  selected: { id: "m1", kind: "primary", code: "JP", name: "Java Programming", degreeType: "bachelor", department: "Engineering", description: null, entryYear: 2026, declaredOn: "2026-09-01", version: { label: "2026 plan", effectiveYear: 2026 } },
  courses: [
    { courseId: "c2", code: "JAVA201", name: "Advanced Java", credits: 3, category: "required", state: "not_started", prerequisites: [{ code: "JAVA101", name: "Java", passed: true }] },
    { courseId: "c1", code: "JAVA101", name: "Java", credits: 3, category: "required", state: "passed", prerequisites: [] },
  ],
};
const minor = { ...primary, selected: { ...primary.selected, id: "m2", kind: "minor", name: "Minor Math", code: "MN" }, courses: [{ courseId: "c3", code: "MA101", name: "Calculus", credits: 3, category: "elective", state: "in_progress", prerequisites: [] }] };
let planResponse: unknown = primary;
const calls: string[] = [];
vi.mock("@/lib/bff", () => ({
  bff: vi.fn(async (path: string) => {
    calls.push(path);
    if (path.startsWith("plan?majorId=m2")) return minor;
    if (path.startsWith("plan")) return planResponse;
    if (path === "courses/c2") return { id: "c2", code: "JAVA201", name: "Advanced Java", credits: 3, syllabus: "Deep dive.", prerequisites: [{ code: "JAVA101", name: "Java", passed: true }], majors: [{ id: "m1", name: "Java Programming", category: "required" }] };
    if (path === "dicts/degree_type") return { code: "degree_type", items: [{ value: "bachelor", label: "Bachelor", labelKey: null }] };
    return [];
  }),
}));

import { PortalPlanPage } from "../src/components/admin/pages/plan-pages";

const page = () => render(
  <NextIntlClientProvider locale="en" messages={en}>
    <PermissionProvider permissions={["portal:plan:view"]}><PortalPlanPage /></PermissionProvider>
  </NextIntlClientProvider>,
);

describe("Degree plan (student)", () => {
  beforeEach(() => { planResponse = primary; calls.length = 0; });

  it("without a major, says so plainly and shows nothing else", async () => {
    planResponse = { majors: [], selected: null, credits: { earned: 0, required: 0 }, categories: [], elective: { earned: 0, min: 0 }, courses: [] };
    page();
    expect((await screen.findByRole("status")).textContent).toContain("You have not chosen a major yet");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows major information, progress and a course table with three states, no suggested term", async () => {
    page();
    expect(await screen.findByText("Java Programming (JP)")).toBeTruthy();
    expect(screen.getByText("Bachelor")).toBeTruthy(); // 学位类型按字典翻成文字
    expect(screen.getByText("2026 plan (2026)")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("33");
    const table = within(screen.getByRole("table"));
    expect(table.queryByRole("columnheader", { name: /Suggested/i })).toBeNull();
    const rows = table.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("Not started")).toBeTruthy();
    expect(within(rows[1]).getByText("Passed")).toBeTruthy();
    expect(within(rows[0]).getByText(/JAVA101/).textContent).toContain("✓"); // 已通过的前置课打勾
    expect(table.queryByText(/Locked|Ready/i)).toBeNull(); // 不判断"能不能修"
  });

  it("with a minor, the student can switch the major; no selector with a single major", async () => {
    page();
    const select = await screen.findByRole("combobox", { name: "Major" });
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Java Programming (Primary)", "Minor Math (Minor)"]);
    await userEvent.setup().selectOptions(select, "m2");
    expect(await screen.findByText("MA101 · Calculus")).toBeTruthy();
    expect(calls.some((c) => c.startsWith("plan?majorId=m2"))).toBe(true);
  });

  it("clicking a course opens its information, with prerequisites", async () => {
    planResponse = { ...primary, majors: [primary.majors[0]] };
    page();
    expect(screen.queryByRole("combobox", { name: "Major" })).toBeNull();
    await userEvent.setup().click(await screen.findByRole("button", { name: "JAVA201 · Advanced Java" }));
    const dialog = within(await screen.findByRole("dialog"));
    await waitFor(() => expect(dialog.getByText("Deep dive.")).toBeTruthy());
    expect(dialog.getByText(/JAVA101 · Java/).textContent).toContain("passed");
    expect(dialog.getByText("Java Programming: Required")).toBeTruthy();
  });
});
