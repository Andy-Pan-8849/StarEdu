// 浏览器调后端 API 的唯一通道：/bff/<路径> → 后端 /api/<路径>。
// 令牌在服务端会话里，由这里加上 Authorization；浏览器只带会话 cookie。
//   - 写操作必须带自定义头 x-requested-with（跨站表单提交带不了自定义头，防 CSRF；cookie 另有 SameSite=Lax）；
//   - 访问令牌快过期自动刷新；后端返回 401 再刷新重试一次。
import { NextRequest, NextResponse } from "next/server";
import { callApi } from "@/lib/auth/api-client";
import { webAuthConfig } from "@/lib/auth/config";
import { freshSession, loadSession, SESSION_COOKIE } from "@/lib/auth/server-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<NextResponse> {
  const config = webAuthConfig();
  if (METHODS_WITH_BODY.has(req.method) && req.headers.get("x-requested-with") !== "staredu") {
    return NextResponse.json({ message: "Missing x-requested-with header" }, { status: 403 });
  }
  const live = await loadSession(req.cookies.get(SESSION_COOKIE)?.value);
  const fresh = live && (await freshSession(live));
  if (!fresh) return NextResponse.json({ message: "Not signed in" }, { status: 401 });

  const path = (await ctx.params).path.map(encodeURIComponent).join("/");
  const body = METHODS_WITH_BODY.has(req.method) ? Buffer.from(await req.arrayBuffer()) : undefined;
  const response = await callApi({
    apiUrl: config.apiUrl,
    host: req.headers.get("host") ?? "",
    method: req.method,
    path: `/api/${path}${req.nextUrl.search}`,
    token: fresh.session.accessToken,
    body: body && body.length > 0 ? body : undefined,
    contentType: req.headers.get("content-type") ?? undefined,
    clientIp: req.headers.get("x-forwarded-for") ?? undefined,
    userAgent: req.headers.get("user-agent") ?? undefined,
  }).catch(() => null);
  if (!response) return NextResponse.json({ message: "Service unavailable" }, { status: 502 });
  return new NextResponse(new Uint8Array(response.body), {
    status: response.status,
    headers: { "content-type": String(response.headers["content-type"] ?? "application/json") },
  });
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
