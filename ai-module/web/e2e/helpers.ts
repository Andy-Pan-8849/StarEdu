import { expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";

export const API = process.env.E2E_API_URL ?? "http://localhost:8000";
const KEYCLOAK = process.env.E2E_KEYCLOAK_URL ?? "http://localhost:8080";
export const PASSWORD = "demo-pass-123";

/** A signed-in page, in its own browser context (its own session). */
export async function signedIn(browser: Browser, username: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/");
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(PASSWORD);
  await page.locator("#kc-login").click();
  await expect(page.getByTestId("who")).toBeVisible();
  return page;
}

/** An access token for calling the API directly (the same demo accounts). */
export async function tokenFor(request: APIRequestContext, username: string): Promise<string> {
  const response = await request.post(`${KEYCLOAK}/realms/starit/protocol/openid-connect/token`, {
    form: { grant_type: "password", client_id: "starit-web", username, password: PASSWORD },
  });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { access_token: string }).access_token;
}

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
