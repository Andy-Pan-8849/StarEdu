import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/auth/session-store", () => ({
  sessionStore: () => ({ get: async () => ({ idToken: "tok", refreshToken: "r", tenantCode: "hq", entry: "admin" }), delete: async () => undefined }),
}));

import { handleAuth } from "../src/lib/auth/flow";

describe("logout", () => {
  // 退出按钮是表单 POST：用 307 会把 POST 带到 Keycloak，Keycloak 弹"确认退出"并丢掉回登录入口的跳转
  it("answers the sign-out POST with a 303 to the identity service's logout URL, returning to the sign-in route", async () => {
    const req = new NextRequest("http://hq.localhost:3001/admin/auth/logout", { method: "POST", headers: { host: "hq.localhost:3001", cookie: "staredu_sid=sid1" } });
    const res = await handleAuth("admin", "logout", req);
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get("location")!);
    expect(to.pathname).toBe("/realms/tenant-hq/protocol/openid-connect/logout");
    expect(to.searchParams.get("post_logout_redirect_uri")).toBe("http://hq.localhost:3001/admin/auth/login");
    expect(to.searchParams.get("id_token_hint")).toBe("tok");
  });
});
