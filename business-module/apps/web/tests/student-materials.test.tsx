// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { StudentMaterials } from "../src/components/admin/pages/material-pages";

const bff = vi.fn();
vi.mock("@/lib/bff", () => ({ bff: (...a: unknown[]) => bff(...a) }));

const wrap = () => render(<NextIntlClientProvider locale="en" messages={en}><StudentMaterials sectionId="s1" /></NextIntlClientProvider>);

describe("student class materials", () => {
  beforeEach(() => bff.mockReset());
  it("shows the link, description and downloadable attachments", async () => {
    bff.mockResolvedValueOnce([{ id: "m1", title: "Week 1", description: "Read first", url: "https://example.com/x", category: "", published: true, files: [{ id: "f1", fileName: "notes.pdf", size: 2048, downloadUrl: "https://store/notes.pdf" }] }]);
    wrap();
    expect((await screen.findByRole("link", { name: "Week 1" })).getAttribute("href")).toBe("https://example.com/x");
    expect(screen.getByText("Read first")).toBeTruthy();
    expect(screen.getByRole("link", { name: "notes.pdf" }).getAttribute("href")).toBe("https://store/notes.pdf");
    expect(bff).toHaveBeenCalledWith("sections/s1/materials");
  });
  it("says so when nothing is published, and shows nothing when the section is not the student's", async () => {
    bff.mockResolvedValueOnce([]);
    const a = wrap();
    expect(await screen.findByText(en.pages.materials.studentEmpty)).toBeTruthy();
    a.unmount();
    bff.mockRejectedValueOnce(new Error("404"));
    const b = wrap();
    await waitFor(() => expect(bff).toHaveBeenCalledTimes(2));
    expect(b.container.textContent).toBe("");
  });
});
