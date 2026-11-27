// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { PermissionProvider } from "../src/components/admin/permissions";

const calls: Array<{ path: string; init?: { method?: string; body?: unknown } }> = [];
let needConfirm = false;
vi.mock("@/lib/bff", () => ({
  bff: vi.fn(async (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, init });
    if (path.startsWith("students?")) return [{ id: "p1", fullName: "Sam Demo", studentNo: "S-1", campusName: "HQ" }, { id: "p2", fullName: "Jo Demo", studentNo: "S-2", campusName: "HQ" }];
    if (path === "sections/s1/enrollments") {
      const body = init?.body as { confirm?: string[] };
      return needConfirm && !body.confirm ? { results: [{ ok: false, code: "CONFIRMATION_REQUIRED", violations: ["capacity"] }] } : { results: [{ ok: true }] };
    }
    return {};
  }),
}));
import { StudentPicker } from "../src/components/admin/pages/student-picker";

const open = (onClose = vi.fn(), onChanged = vi.fn()) => render(
  <NextIntlClientProvider locale="en" messages={en}>
    <PermissionProvider permissions={["edu:enrollment:add"]}><StudentPicker sectionId="s1" exclude={["p2"]} onChanged={onChanged} onClose={onClose} /></PermissionProvider>
  </NextIntlClientProvider>,
);

describe("student picker (roster '+')", () => {
  beforeEach(() => { calls.length = 0; needConfirm = false; });

  it("searches a few students at a time (not the whole school), hides those already in the class, and enrolls the selected ones", async () => {
    const u = userEvent.setup();
    const onClose = vi.fn();
    open(onClose);
    const dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByText("Sam Demo")).toBeTruthy();
    expect(dialog.queryByText("Jo Demo")).toBeNull(); // 已经在班里
    expect(calls.some((c) => c.path.startsWith("students?") && c.path.includes("size=20"))).toBe(true);
    await u.type(dialog.getByRole("textbox", { name: "Search by name or student number" }), "sam");
    await waitFor(() => expect(calls.some((c) => c.path.includes("q=sam"))).toBe(true));
    await u.click(dialog.getByRole("checkbox", { name: "Sam Demo" }));
    await u.click(dialog.getByRole("button", { name: "Enroll" }));
    await waitFor(() => expect(calls.find((c) => c.path === "sections/s1/enrollments")?.init?.body).toMatchObject({ studentIds: ["p1"] }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("asks for confirmation and a reason when a rule needs it", async () => {
    needConfirm = true;
    const u = userEvent.setup();
    const onClose = vi.fn();
    open(onClose);
    const dialog = within(await screen.findByRole("dialog"));
    await u.click(await dialog.findByRole("checkbox", { name: "Sam Demo" }));
    await u.click(dialog.getByRole("button", { name: "Enroll" }));
    expect(await dialog.findByText(/These need confirmation/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    const confirm = dialog.getByRole("button", { name: "Confirm and enroll" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true); // 没填原因不能确认
    await u.type(dialog.getByRole("textbox", { name: "Reason (required)" }), "approved by dean");
    await u.click(confirm);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.filter((c) => c.path === "sections/s1/enrollments").at(-1)?.init?.body).toMatchObject({ confirm: ["capacity"], reason: "approved by dean" });
  });
});
