// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { PermissionProvider } from "../src/components/admin/permissions";

const calls: Array<{ path: string; init?: { method?: string; body?: unknown } }> = [];
vi.mock("@/lib/bff", () => ({
  bff: vi.fn(async (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, init });
    if (path.startsWith("terms")) return [{ id: "t1", code: "2026F", name: "2026 Fall" }];
    if (path.startsWith("courses")) return [{ id: "c1", code: "JAVA101", name: "Java Programming" }];
    if (path.startsWith("majors")) return [{ id: "m1", code: "CS", name: "Computer Science" }];
    if (path === "edu-campuses") return [{ id: "k1", code: "HQ", name: "Beijing Headquarter", status: "normal" }];
    if (path === "enrollment-batches") return { dryRun: true, summary: { ok: 1, needConfirmation: 0, failed: 0 }, rows: [{ studentId: "p1", fullName: "Sam Demo", studentNo: "S1", sectionName: "Java 01", ok: true }] };
    return [];
  }),
}));
import { BatchEnrollPanel } from "../src/components/admin/pages/edu-pages";

describe("enroll a cohort", () => {
  beforeEach(() => { calls.length = 0; });
  it("picks term, course and major by searching (limited), loads campuses from the registrar-safe list, and previews with the chosen ids", async () => {
    const u = userEvent.setup();
    render(<NextIntlClientProvider locale="en" messages={en}><PermissionProvider permissions={["edu:enrollment:add"]}><BatchEnrollPanel onClose={() => undefined} /></PermissionProvider></NextIntlClientProvider>);
    const dialog = within(await screen.findByRole("dialog", { name: "Enroll a cohort" }));
    expect(calls.some((c) => c.path === "edu-campuses")).toBe(true);
    expect(calls.some((c) => c.path === "campuses")).toBe(false);
    expect(calls.some((c) => c.path === "courses" || c.path === "majors" || c.path === "terms")).toBe(false); // 打开窗口时不取全部
    for (const [label, text] of [["Term", "2026 Fall"], ["Course", "JAVA101 · Java Programming"], ["Major", "CS · Computer Science"]] as const) {
      await u.click(dialog.getByRole("textbox", { name: label }));
      await u.click(await dialog.findByRole("option", { name: text }));
    }
    expect(calls.some((c) => c.path.startsWith("courses?status=enabled&limit=20"))).toBe(true);
    await u.click(dialog.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(calls.find((c) => c.path === "enrollment-batches")?.init?.body).toMatchObject({ termId: "t1", courseId: "c1", majorId: "m1", dryRun: true }));
  });
});
