/**
 * 文件：e2e/helpers.ts
 * 作用：端到端测试的辅助函数：signedIn 打开新的浏览器上下文并通过真实的 Keycloak 登录页登录；
 * tokenFor 用密码授权取令牌，bearer 生成请求头，用于直接调用 API。地址可用环境变量 E2E_* 覆盖。
 */

import { expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";

export const API = process.env.E2E_API_URL ?? "http://localhost:8000";
const KEYCLOAK = process.env.E2E_KEYCLOAK_URL ?? "http://localhost:8080";
export const PASSWORD = "demo-pass-123";

/**
 * 返回一个已登录的页面，放在独立的浏览器上下文里（独立的会话）。
 */
export async function signedIn(browser: Browser, username: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/");
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(PASSWORD);
  await page.locator("#kc-login").click();
  await expect(page.getByTestId("who")).toBeVisible();
  return page;
}

/**
 * 为演示账号取一个访问令牌，用来直接调 API（和网页用同一批账号）。
 */
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
