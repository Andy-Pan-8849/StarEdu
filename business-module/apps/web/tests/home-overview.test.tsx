// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { PermissionProvider } from "../src/components/admin/permissions";

vi.mock("@/lib/bff", () => ({
  bff: vi.fn(async (path: string) => {
    if (path === "me/profile") return { fullName: "Reg Demo", username: "demo.registrar" };
    if (path.startsWith("notifications")) return { unread: 0, items: [] };
    if (path === "dashboard/overview") return { totals: { sections: 4, inProgressSections: 3, students: 20 }, campuses: [{ campusId: "c1", campus: "Beijing HQ", sections: 4, inProgressSections: 3, students: 20, completionRate: 87.5, averageScore: 76, lateRate: null }] };
    return [];
  }),
}));
vi.mock("../src/components/admin/nav-context", () => ({ useNav: () => ({ openPage: () => undefined }) }));
import { HomePage } from "../src/components/admin/pages/home-page";

const page = (perms: string[]) => render(<NextIntlClientProvider locale="en" messages={en}><PermissionProvider permissions={perms}><HomePage /></PermissionProvider></NextIntlClientProvider>);

describe("Home: campus overview", () => {
  it("shows the per-campus table to people who may view the dashboard", async () => {
    page(["edu:dashboard:view"]);
    expect(await screen.findByText("Beijing HQ")).toBeTruthy();
    expect(screen.getByText("87.5%")).toBeTruthy();
    expect(screen.getByText("Late rate")).toBeTruthy();
  });
  it("shows no campus block without the permission", async () => {
    page([]);
    await screen.findByText(/Reg Demo/);
    expect(screen.queryByText("Beijing HQ")).toBeNull();
  });
});
