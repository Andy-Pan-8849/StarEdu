// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { PermissionProvider } from "../src/components/admin/permissions";

const rows = [
  { id: "m1", title: "Week 1 slides", description: "Read chapter 1", url: "https://example.test/w1", category: "slides", published: true, files: [{ id: "f1", fileName: "week1.pdf", size: 2048, downloadUrl: "https://files.test/week1.pdf" }] },
  { id: "m2", title: "Notes", description: "", url: null, category: "slides", published: false, files: [] },
];
const calls: Array<{ path: string; init?: { method?: string; body?: unknown } }> = [];
vi.mock("@/lib/bff", () => ({
  bff: vi.fn(async (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, init });
    if (path.endsWith("/materials/uploads")) return { fileId: "new-file", uploadUrl: "https://store.test/put", headers: {} };
    return init?.method ? {} : rows;
  }),
}));
import { MaterialsPanel } from "../src/components/admin/pages/material-pages";

const page = (perms = ["edu:material:edit"]) => render(
  <NextIntlClientProvider locale="en" messages={en}>
    <PermissionProvider permissions={perms}><MaterialsPanel sectionId="s1" /></PermissionProvider>
  </NextIntlClientProvider>,
);

describe("Class section materials", () => {
  beforeEach(() => { calls.length = 0; vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 }))); vi.stubGlobal("confirm", () => true); });

  it("is a list with name (linked), description, attachments and row actions; Add sits above it", async () => {
    page();
    const link = await screen.findByRole("link", { name: "Week 1 slides" });
    expect(link.getAttribute("href")).toBe("https://example.test/w1");
    expect(screen.getByRole("link", { name: "week1.pdf" }).getAttribute("href")).toBe("https://files.test/week1.pdf");
    expect(screen.getByText("Read chapter 1")).toBeTruthy();
    for (const h of ["Name", "Description", "Attachments"]) expect(screen.getByRole("columnheader", { name: h })).toBeTruthy();
    const add = screen.getByRole("button", { name: "Add" });
    expect(add.compareDocumentPosition(screen.getByRole("table")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Details" }).length).toBe(2);
  });

  it("Add opens a dialog (not an inline form); files are uploaded straight to storage, then attached on save", async () => {
    page();
    await screen.findByRole("link", { name: "Week 1 slides" });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const dialog = await screen.findByRole("dialog", { name: "Add material" });
    const u = userEvent.setup();
    await u.type(within(dialog).getByLabelText("Name"), "Lab 1");
    await u.type(within(dialog).getByLabelText("Description"), "Do the lab");
    await u.upload(within(dialog).getByLabelText("Add files"), new File(["abc"], "lab.pptx"));
    expect(within(dialog).getByText("lab.pptx")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "POST" && c.path === "sections/s1/materials")).toBe(true));
    expect(calls.find((c) => c.path.endsWith("/uploads"))?.init?.body).toMatchObject({ fileName: "lab.pptx", size: 3 });
    expect(fetch).toHaveBeenCalledWith("https://store.test/put", expect.objectContaining({ method: "PUT" }));
    expect(calls.find((c) => c.path === "sections/s1/materials" && c.init?.method === "POST")?.init?.body).toMatchObject({ title: "Lab 1", description: "Do the lab", url: null, fileIds: ["new-file"] });
  });

  it("Details is read-only; Edit keeps the existing files and Delete removes the material", async () => {
    page();
    await screen.findByRole("link", { name: "Week 1 slides" });
    fireEvent.click(screen.getAllByRole("button", { name: "Details" })[0]);
    const view = await screen.findByRole("dialog", { name: "Week 1 slides" });
    expect(within(view).queryByRole("textbox")).toBeNull();
    fireEvent.click(within(view).getAllByRole("button", { name: "Close" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const edit = await screen.findByRole("dialog", { name: "Edit material" });
    expect(within(edit).getByDisplayValue("Read chapter 1")).toBeTruthy();
    fireEvent.click(within(edit).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.init?.method === "PATCH")?.init?.body).toMatchObject({ fileIds: ["f1"] }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]);
    await waitFor(() => expect(calls.some((c) => c.init?.method === "DELETE" && c.path === "sections/s1/materials/m2")).toBe(true));
  });

  it("without edit permission there is no Add, Edit or Delete, only Details", async () => {
    page([]);
    await screen.findByRole("link", { name: "Week 1 slides" });
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Details" }).length).toBe(2);
  });
});
