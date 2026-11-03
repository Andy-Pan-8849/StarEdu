import { expect, test } from "@playwright/test";
import { API, bearer, signedIn, tokenFor } from "./helpers";

const NOTE = [
  "# E2E travel notes",
  "",
  "## Hotels",
  "",
  "The hotel limit for the end-to-end test city is CNY 600 per night.",
  "",
].join("\n");

test.describe.configure({ mode: "serial" });

test("an ordinary user gets the assistant but not document management", async ({
  browser,
  request,
}) => {
  const page = await signedIn(browser, "ning.adm.bj");
  await expect(page.getByTestId("who")).toContainText("staff");
  await expect(page.getByRole("link", { name: "Assistant" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Documents" })).toHaveCount(0);

  await page.goto("/admin/documents");
  await expect(page.getByRole("alert")).toContainText("do not have permission");

  // The back end refuses on its own, whatever the page shows.
  const token = await tokenFor(request, "ning.adm.bj");
  expect((await request.get(`${API}/documents`, { headers: bearer(token) })).status()).toBe(403);
  await page.close();
});

test("a question is answered with a source that can be opened", async ({ browser }) => {
  const page = await signedIn(browser, "ning.adm.bj");
  // The model is replaced here (no paid calls): the reply is fixed, the page and API are real.
  await page.route("**/conversations/*/messages", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      json: {
        run_id: "00000000-0000-0000-0000-000000000000",
        message: {
          id: "00000000-0000-0000-0000-000000000001",
          role: "assistant",
          content: "Hotels in tier 1 cities are limited to CNY 600 per night [1].",
          citations: [{ n: 1, kind: "data", views: ["expense_claims"], row_count: 4 }],
        },
        end_state: "answered",
        end_reason: null,
      },
    });
  });
  await page.getByLabel("Your question").fill("What is the hotel limit?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("limited to CNY 600 per night")).toBeVisible();
  await page.getByRole("button", { name: "Show source 1" }).click();
  await expect(page.getByRole("complementary", { name: "Source" })).toContainText("expense_claims");
  await page.close();
});

test("an administrator uploads a document that then can be read from a citation", async ({
  browser,
  request,
}) => {
  const code = `E2E-${Date.now()}`;
  const admin = await signedIn(browser, "min.ragetl.bj");
  await expect(admin.getByTestId("who")).toContainText("RAGETLAdmin");
  await admin.getByRole("link", { name: "Documents" }).click();
  await admin.getByRole("button", { name: "Upload a document" }).click();

  await admin.getByLabel("File").setInputFiles({
    name: "e2e-notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(NOTE),
  });
  await admin.getByLabel("Document code").fill(code);
  await admin.getByLabel("Title").fill("E2E travel notes");
  await admin.getByLabel("Domain").selectOption("finance");
  await admin.getByLabel("Who may read it").selectOption("all-staff");
  await admin.getByRole("button", { name: "Upload" }).click();
  await expect(admin.getByRole("status")).toContainText(code);

  const row = admin.getByRole("row", { name: new RegExp(code) });
  await expect(row).toContainText("ready", { timeout: 90_000 });

  // The ordinary user can read it; the administrator account (no business role) cannot.
  const adminToken = await tokenFor(request, "min.ragetl.bj");
  const listed = await request.get(`${API}/documents?q=${code}`, { headers: bearer(adminToken) });
  const documentId = ((await listed.json()) as { items: { id: string }[] }).items[0]?.id ?? "";
  expect(documentId).not.toBe("");
  expect(
    (
      await request.get(`${API}/documents/${documentId}/chunks`, { headers: bearer(adminToken) })
    ).status(),
  ).toBe(404);

  const staffToken = await tokenFor(request, "ning.adm.bj");
  const chunks = await request.get(`${API}/documents/${documentId}/chunks`, {
    headers: bearer(staffToken),
  });
  expect(chunks.status()).toBe(200);
  const chunkId = ((await chunks.json()) as { chunks: { id: string }[] }).chunks[0]?.id ?? "";

  const staff = await signedIn(browser, "ning.adm.bj");
  await staff.route("**/conversations/*/messages", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      json: {
        run_id: "00000000-0000-0000-0000-000000000000",
        message: {
          id: "00000000-0000-0000-0000-000000000002",
          role: "assistant",
          content: "The limit is CNY 600 per night [1].",
          citations: [
            {
              n: 1,
              kind: "document",
              doc_code: code,
              title: "E2E travel notes",
              version: "1.0",
              status: "active",
              heading_path: ["E2E travel notes", "Hotels"],
              page: null,
              chunk_id: chunkId,
              document_id: documentId,
            },
          ],
        },
        end_state: "answered",
        end_reason: null,
      },
    });
  });
  await staff.getByLabel("Your question").fill("hotel limit");
  await staff.getByRole("button", { name: "Send" }).click();
  await staff.getByRole("button", { name: "Show source 1" }).click();
  await expect(staff.getByRole("complementary", { name: "Source" })).toContainText(
    "CNY 600 per night",
  );
  await staff.close();

  // Clean up through the page: delete asks first, then the row is gone.
  await admin.getByRole("button", { name: `Delete ${code}` }).click();
  await admin.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(row).toHaveCount(0);
  await admin.close();
});
