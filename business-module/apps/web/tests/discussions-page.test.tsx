// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { PermissionProvider } from "../src/components/admin/permissions";

const author = { personId: "p", name: "Sam", role: "student" };
const data = {
  unread: 1,
  sections: [{ id: "a", name: "Java (DEMO 01)", unread: 1 }, { id: "b", name: "Python (DEMO 01)", unread: 0 }],
  // 服务端已经把未读排在最前
  threads: [
    { id: "t1", section: { id: "a", name: "Java (DEMO 01)" }, title: "Unread question", author, pinned: false, resolved: false, replyCount: 0, lastActivityAt: "2026-11-20T10:00:00Z", unread: true },
    { id: "t2", section: { id: "b", name: "Python (DEMO 01)" }, title: "Old thread", author, pinned: false, resolved: true, replyCount: 3, lastActivityAt: "2026-11-25T10:00:00Z", unread: false },
  ],
};
vi.mock("@/lib/bff", () => ({ bff: vi.fn(async (path: string) => (path === "discussions" ? data : [])) }));

import { PortalDiscussionsPage } from "../src/components/admin/pages/discussion-pages";

const page = () => render(
  <NextIntlClientProvider locale="en" messages={en}>
    <PermissionProvider permissions={["portal:discussion:list", "portal:discussion:post"]}><PortalDiscussionsPage /></PermissionProvider>
  </NextIntlClientProvider>,
);

describe("Discussions (student)", () => {
  it("shows all class sections by default, unread first and marked, with a Class Section column", async () => {
    page();
    const table = within(await screen.findByRole("table"));
    expect(table.getByRole("columnheader", { name: "Class Section" })).toBeTruthy();
    const rows = table.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Unread question")).toBeTruthy();
    expect(within(rows[0]).getByRole("img", { name: "Unread" })).toBeTruthy();
    expect(within(rows[0]).getByText("Java (DEMO 01)")).toBeTruthy();
    expect(within(rows[1]).queryByRole("img", { name: "Unread" })).toBeNull();
    // 没选班级时不能发帖，提示先选
    expect(screen.getByText("To start a discussion, pick a class section above.")).toBeTruthy();
  });

  it("choosing a class section filters the list to it, and lets the student post there", async () => {
    page();
    const select = await screen.findByRole("combobox", { name: "Pick a section" });
    expect(within(select).getByRole("option", { name: "All class sections (1 unread)" })).toBeTruthy();
    await userEvent.setup().selectOptions(select, "b");
    await waitFor(() => expect(within(screen.getByRole("table")).getAllByRole("row").slice(1)).toHaveLength(1));
    expect(screen.getByText("Old thread")).toBeTruthy();
    expect(screen.queryByText("Unread question")).toBeNull();
    expect(screen.getByRole("heading", { name: "New discussion" })).toBeTruthy();
  });
});
