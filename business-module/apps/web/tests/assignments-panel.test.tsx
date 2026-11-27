// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { PermissionProvider } from "../src/components/admin/permissions";

const rows = [
  { id: "a1", title: "Homework 1", description: "Solve the set", allowLate: true, dueDate: "2026-12-01", published: true, maxScore: 10, group: null, rubric: [{ id: "r1", title: "Correctness", maxPoints: 6 }, { id: "r2", title: "Style", maxPoints: 4 }], counts: { submitted: 2, grading: 1, published: 0 } },
];
const calls: Array<{ path: string; init?: { method?: string; body?: unknown } }> = [];
vi.mock("@/lib/bff", () => ({ bff: vi.fn(async (path: string, init?: { method?: string; body?: unknown }) => { calls.push({ path, init }); return init?.method ? {} : rows; }) }));
import { AssignmentsPanel, rubricText } from "../src/components/admin/pages/assignment-pages";

const page = (perms = ["edu:assignment:list", "edu:assignment:edit"]) => render(
  <NextIntlClientProvider locale="en" messages={en}>
    <PermissionProvider permissions={perms}><AssignmentsPanel sectionId="s1" /></PermissionProvider>
  </NextIntlClientProvider>,
);

describe("Class section assignments", () => {
  beforeEach(() => { calls.length = 0; vi.stubGlobal("confirm", () => true); });

  it("is a list with the new button above it; details are read-only and show the rubric", async () => {
    page();
    await screen.findByRole("button", { name: "Homework 1" });
    for (const h of ["Title", "Due date", "Points", "Submissions", "Status"]) expect(screen.getByRole("columnheader", { name: h })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New assignment" }).compareDocumentPosition(screen.getByRole("table")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const d = await screen.findByRole("dialog", { name: "Homework 1" });
    expect(within(d).getByText("Correctness — 6")).toBeTruthy();
    expect(within(d).queryByRole("textbox")).toBeNull();
  });

  it("edit saves the fields and only replaces the rubric when it changed; delete removes the row", async () => {
    page();
    await screen.findByRole("button", { name: "Homework 1" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dlg = await screen.findByRole("dialog", { name: "Edit assignment" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true));
    expect(calls.some((c) => c.path.endsWith("/rubric"))).toBe(false);
    expect(rubricText(rows[0].rubric)).toBe("Correctness: 6\nStyle: 4");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "DELETE" && c.path === "sections/s1/assignments/a1")).toBe(true));
  });
});
