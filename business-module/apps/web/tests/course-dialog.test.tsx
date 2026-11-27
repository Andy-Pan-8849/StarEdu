// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { PermissionProvider } from "../src/components/admin/permissions";

const calls: Array<{ path: string; init?: { method?: string; body?: unknown } }> = [];
let prereqs = [{ id: "p1", code: "CS100", name: "Intro", credits: 2 }];
const detail = () => ({ id: "c1", code: "CS201", name: "Data Structures", credits: 3, syllabus: "Lists and trees.", status: true, prerequisites: prereqs, majors: [{ code: "CS", name: "Computer Science", category: "required" }], sections: [] });
vi.mock("@/lib/bff", () => ({
  bff: vi.fn(async (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, init });
    if (path === "courses/c1") return detail();
    if (path === "courses/c1/prerequisites") { prereqs = (init?.body as { courseIds: string[] }).courseIds.map((id) => ({ id, code: id === "p2" ? "MA101" : "CS100", name: id === "p2" ? "Calculus" : "Intro", credits: 2 })); return {}; }
    if (path.startsWith("courses?")) return [{ id: "p1", code: "CS100", name: "Intro", credits: 2 }, { id: "c1", code: "CS201", name: "Data Structures", credits: 3 }, { id: "p2", code: "MA101", name: "Calculus", credits: 2 }];
    return {};
  }),
}));
import { CourseDialog } from "../src/components/admin/pages/course-dialogs";

const open = (mode: "view" | "edit") => render(
  <NextIntlClientProvider locale="en" messages={en}>
    <PermissionProvider permissions={["edu:course:list", "edu:course:edit"]}><CourseDialog id="c1" mode={mode} onClose={() => undefined} onSaved={() => undefined} /></PermissionProvider>
  </NextIntlClientProvider>,
);

describe("course dialog", () => {
  beforeEach(() => { calls.length = 0; prereqs = [{ id: "p1", code: "CS100", name: "Intro", credits: 2 }]; });

  it("details are read-only: labels only, no inputs or add/remove, prerequisites listed", async () => {
    const u = userEvent.setup();
    open("view");
    const dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByText("Lists and trees.")).toBeTruthy();
    expect(dialog.queryByRole("textbox")).toBeNull();
    expect(dialog.queryByRole("button", { name: "Save" })).toBeNull();
    await u.click(dialog.getByRole("tab", { name: "Prerequisites" }));
    expect(dialog.getByText("CS100")).toBeTruthy();
    expect(dialog.queryByRole("button", { name: "Add prerequisite" })).toBeNull();
    expect(dialog.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("edit has a form tab and a prerequisites list; '+' opens a search window (not the whole catalogue) and adding saves the list", async () => {
    const u = userEvent.setup();
    open("edit");
    const dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByDisplayValue("Data Structures")).toBeTruthy();
    await u.click(dialog.getByRole("tab", { name: "Prerequisites" }));
    await u.click(dialog.getByRole("button", { name: "Add prerequisite" }));
    const picker = within(await screen.findByRole("dialog", { name: "Choose a prerequisite course" }));
    await waitFor(() => expect(picker.getByText("MA101")).toBeTruthy());
    expect(picker.queryByText("CS201")).toBeNull(); // 课程自己不能当先修课
    expect(picker.queryByText("CS100")).toBeNull(); // 已经是先修课的不再出现
    expect(calls.some((c) => c.path.startsWith("courses?") && c.path.includes("limit=20") && c.path.includes("status=enabled"))).toBe(true);
    await u.type(picker.getByRole("textbox", { name: "Search by code or name" }), "calc");
    await waitFor(() => expect(calls.some((c) => c.path.includes("q=calc"))).toBe(true));
    await u.click(picker.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(calls.find((c) => c.path === "courses/c1/prerequisites")?.init?.body).toEqual({ courseIds: ["p1", "p2"] }));
  });

  it("removing a prerequisite saves the shorter list", async () => {
    const u = userEvent.setup();
    open("edit");
    const dialog = within(await screen.findByRole("dialog"));
    await u.click(await dialog.findByRole("tab", { name: "Prerequisites" }));
    await u.click(await dialog.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(calls.find((c) => c.path === "courses/c1/prerequisites")?.init?.body).toEqual({ courseIds: [] }));
  });
});
