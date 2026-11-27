// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { PermissionProvider } from "../src/components/admin/permissions";

let response: unknown;
vi.mock("@/lib/bff", () => ({ bff: vi.fn(async () => response) }));
import { PortalEnrollPage } from "../src/components/admin/pages/edu-pages";

const page = () => render(
  <NextIntlClientProvider locale="en" messages={en}>
    <PermissionProvider permissions={["portal:enroll:list", "portal:enroll:add"]}><PortalEnrollPage /></PermissionProvider>
  </NextIntlClientProvider>,
);

describe("Course enrollment filter", () => {
  beforeEach(() => { response = { declaredMajor: null, majors: [], sections: [] }; });

  it("without a major there is no filter (it used to produce an empty list), and the page says why labels are missing", async () => {
    page();
    expect((await screen.findByText(/You have not chosen a major yet/)).textContent).toContain("contact the academic office");
    expect(screen.queryByRole("combobox", { name: "Filter" })).toBeNull();
  });

  it("with majors, the filter offers all courses and each of my majors", async () => {
    response = { declaredMajor: { name: "A" }, majors: [{ id: "a", name: "A", kind: "primary" }, { id: "b", name: "B", kind: "minor" }], sections: [] };
    page();
    const select = await screen.findByRole("combobox", { name: "Filter" });
    expect(Array.from(select.querySelectorAll("option")).map((o) => o.textContent)).toEqual(["All courses", "A", "B"]);
  });
});
