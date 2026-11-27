// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { PermissionProvider } from "../src/components/admin/permissions";

const calls: Array<{ path: string; init?: { method?: string; body?: unknown } }> = [];
let courses: Array<{ courseId: string; code: string; name: string; credits: number; category: string; suggestedTerm: number | null }> = [{ courseId: "c1", code: "CS101", name: "Intro", credits: 3, category: "required", suggestedTerm: 1 }];
const detail = () => ({ id: "m1", name: "Computer Science", versionId: "v1", totalCredits: 120, electiveMinCredits: 20, versions: [{ id: "v1", label: "2026 curriculum", effectiveYear: 2026, entryYearFrom: null, entryYearTo: null, courseCount: courses.length }], courses });
vi.mock("@/lib/bff", () => ({
  bff: vi.fn(async (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, init });
    if (path.startsWith("majors/m1/courses")) { courses = (init?.body as { items: Array<{ courseId: string; category: string; suggestedTerm: number | null }> }).items.map((i) => ({ ...i, code: i.courseId === "c2" ? "MA101" : "CS101", name: i.courseId === "c2" ? "Calculus" : "Intro", credits: 3 })); return {}; }
    if (path.startsWith("majors/m1")) return detail();
    if (path.startsWith("courses?")) return [{ id: "c1", code: "CS101", name: "Intro", credits: 3 }, { id: "c2", code: "MA101", name: "Calculus", credits: 3 }];
    if (path.startsWith("dicts/")) return { items: [{ value: "bachelor", label: "Bachelor", labelKey: null }] };
    return {};
  }),
}));
import { MajorDialog } from "../src/components/admin/pages/major-dialogs";

const row = { id: "m1", code: "CS", name: "Computer Science", degreeType: "bachelor", totalCredits: 120, status: true };
const open = (mode: "view" | "edit") => render(
  <NextIntlClientProvider locale="en" messages={en}>
    <PermissionProvider permissions={["edu:major:list", "edu:major:edit"]}><MajorDialog row={row} mode={mode} onClose={() => undefined} onSaved={() => undefined} /></PermissionProvider>
  </NextIntlClientProvider>,
);

describe("major dialog", () => {
  beforeEach(() => { calls.length = 0; courses = [{ courseId: "c1", code: "CS101", name: "Intro", credits: 3, category: "required", suggestedTerm: 1 }]; });

  it("details are read-only on both tabs: no inputs, no add or remove", async () => {
    const u = userEvent.setup();
    open("view");
    const dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByText("Bachelor")).toBeTruthy();
    expect(dialog.queryByRole("textbox")).toBeNull();
    await u.click(dialog.getByRole("tab", { name: "Curriculum" }));
    expect(await dialog.findByText("CS101")).toBeTruthy();
    expect(dialog.getByText("Required")).toBeTruthy();
    expect(dialog.queryByRole("textbox")).toBeNull();
    expect(dialog.queryByRole("combobox", { name: /Category/ })).toBeNull();
    expect(dialog.queryByRole("button", { name: "Add course" })).toBeNull();
    expect(dialog.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("edit: '+' opens a search window to add a course; category changes and removal save at once", async () => {
    const u = userEvent.setup();
    open("edit");
    const dialog = within(await screen.findByRole("dialog"));
    await u.click(await dialog.findByRole("tab", { name: "Curriculum" }));
    await u.click(await dialog.findByRole("button", { name: "Add course" }));
    const picker = within(await screen.findByRole("dialog", { name: "Choose a course" }));
    await waitFor(() => expect(picker.getByText("MA101")).toBeTruthy());
    expect(picker.queryByText("CS101")).toBeNull(); // 已在培养方案里
    expect(calls.some((c) => c.path.startsWith("courses?") && c.path.includes("limit=20") && c.path.includes("status=enabled"))).toBe(true);
    await u.click(picker.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(calls.find((c) => c.path.startsWith("majors/m1/courses"))?.init?.body).toEqual({ items: [{ courseId: "c1", category: "required", suggestedTerm: 1 }, { courseId: "c2", category: "required", suggestedTerm: null }] }));
    await u.selectOptions(await dialog.findByRole("combobox", { name: "CS101 Category" }), "elective");
    await waitFor(() => expect(calls.filter((c) => c.path.startsWith("majors/m1/courses")).at(-1)?.init?.body).toMatchObject({ items: [{ courseId: "c1", category: "elective" }, { courseId: "c2" }] }));
    await u.click((await dialog.findAllByRole("button", { name: "Remove" }))[1]);
    await waitFor(() => expect((calls.filter((c) => c.path.startsWith("majors/m1/courses")).at(-1)?.init?.body as { items: unknown[] }).items).toHaveLength(1));
  });
});
