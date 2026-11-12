import type { NextRequest } from "next/server";
import { handleAuth } from "@/lib/auth/flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ action: string }> };
export async function GET(req: NextRequest, ctx: Ctx) {
  return handleAuth("platform", (await ctx.params).action, req);
}
export const POST = GET;
