// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { PermissionProvider } from "../src/components/admin/permissions";

const options = vi.hoisted(() => ({ value: { appeals: [], extensions: [], appealWindowDays: 14, maxExtensionDays: 3 } as Record<string, unknown> }));
vi.mock("@/lib/bff", () => ({
  bff: vi.fn(async (path: string) => (path === "requests/options" ? options.value : [])),
}));

import { PortalRequestsPage } from "../src/components/admin/pages/request-pages";

const open = async () => {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <PermissionProvider permissions={["portal:request:list", "portal:request:submit"]}>
        <PortalRequestsPage />
      </PermissionProvider>
    </NextIntlClientProvider>,
  );
  await userEvent.setup().click(await screen.findByRole("button", { name: "Add" }));
  return within(await screen.findByRole("dialog"));
};

describe("My requests: choosing what to ask for", () => {
  beforeEach(() => {
    options.value = { appeals: [], extensions: [], appealWindowDays: 14, maxExtensionDays: 3 };
  });

  it("explains when nothing can be asked for, instead of showing an empty list", async () => {
    const dialog = await open();
    await waitFor(() => expect(dialog.getByRole("status").textContent).toContain("nothing to ask for"));
    expect(dialog.queryByRole("combobox", { name: "Choose what to ask for" })).toBeNull();
    expect(dialog.queryByRole("textbox")).toBeNull(); // 没有可申请的，就不给原因输入框和提交按钮
    expect(dialog.queryByRole("button", { name: "Submit request" })).toBeNull();
  });

  it("lists what can be asked for, grouped by kind", async () => {
    options.value = {
      appeals: [{ enrollmentId: "e1", section: "Java 101", total: 88.5, grade: "B", closesAt: "2026-12-01T00:00:00Z" }],
      extensions: [{ assignmentId: "a1", title: "Lab 2", section: "Python 101", dueAt: "2026-12-01T00:00:00Z", currentDays: 0 }],
      appealWindowDays: 14,
      maxExtensionDays: 3,
    };
    const dialog = await open();
    const select = await dialog.findByRole("combobox", { name: "Choose what to ask for" });
    await waitFor(() => expect(within(select).getAllByRole("option").length).toBe(3));
    expect(within(select).getByRole("group", { name: "Grade appeal" })).toBeTruthy();
    expect(within(select).getByRole("group", { name: "Extension" })).toBeTruthy();
  });
});
