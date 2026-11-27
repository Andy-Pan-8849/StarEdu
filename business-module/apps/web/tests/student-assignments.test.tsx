// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { PermissionProvider } from "../src/components/admin/permissions";

const row = (id: string, title: string, status: string, canSubmit: boolean) => ({ id, title, section: { id: "s1", name: "x", course: "Java" }, deadline: "2027-01-01T00:00:00Z", extensionDays: 0, status, isLate: false, finalScore: null, maxScore: 100, canSubmit });
const rows = [row("a1", "Homework 1", "missing", true), row("a2", "Homework 2", "submitted", true), row("a3", "Homework 3", "published", false)];
const detail = (id: string, canSubmit: boolean) => ({ id, title: "Homework", description: "Write a loop.", section: { name: "x" }, deadline: "2027-01-01T00:00:00Z", allowLate: false, maxScore: 100, canSubmit, limits: { maxFiles: 3 }, rubric: [{ id: "r1", title: "Correctness", maxPoints: 100 }], submission: null });
vi.mock("@/lib/bff", () => ({
  bff: vi.fn(async (path: string) => (path === "assignments" ? rows : path.startsWith("assignments/") ? detail(path.split("/")[1], path !== "assignments/a3") : [])),
}));
import { StudentAssignmentList } from "../src/components/admin/pages/assignment-pages";

const page = () => render(
  <NextIntlClientProvider locale="en" messages={en}>
    <PermissionProvider permissions={["portal:assignment:list", "portal:assignment:submit"]}><StudentAssignmentList /></PermissionProvider>
  </NextIntlClientProvider>,
);

describe("student assignment list", () => {
  it("offers Submit before submitting, Submit again after, and nothing once submitting is closed", async () => {
    page();
    const r = (name: string) => within(screen.getByText(name).closest("tr") as HTMLElement);
    await screen.findByText("Homework 1");
    expect(r("Homework 1").getByRole("button", { name: "Submit" })).toBeTruthy();
    expect(r("Homework 2").getByRole("button", { name: "Submit again" })).toBeTruthy();
    expect(r("Homework 3").queryByRole("button", { name: /Submit/ })).toBeNull();
    expect(r("Homework 3").getByRole("button", { name: "Details" })).toBeTruthy();
  });

  it("Details is a read-only dialog; Submit is a dialog with the answer form", async () => {
    const u = userEvent.setup();
    page();
    await screen.findByText("Homework 1");
    const row1 = within(screen.getByText("Homework 1").closest("tr") as HTMLElement);
    await u.click(row1.getByRole("button", { name: "Details" }));
    let dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByText("Write a loop.")).toBeTruthy();
    expect(dialog.queryByRole("textbox")).toBeNull();
    await u.click(dialog.getByRole("button", { name: "Close" }));
    await u.click(row1.getByRole("button", { name: "Submit" }));
    dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByRole("textbox")).toBeTruthy();
  });
});
