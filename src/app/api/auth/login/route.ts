// GET /api/auth/login?return_to=/path — hand off to the IdP.
import { NextResponse } from "next/server";
import { beginLogin } from "@/lib/oidc";
import { checkRateLimit } from "@/lib/ratelimit";
import { errorResponse } from "../../_util";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    // Unauthenticated and it writes a row every call — without a limiter, hammering this endpoint
    // grows oidc_flows without bound.
    checkRateLimit(request);
    const returnTo = new URL(request.url).searchParams.get("return_to");
    const { url, cookie } = await beginLogin(request, returnTo);
    const res = NextResponse.redirect(url, 302);
    res.headers.append("set-cookie", cookie);
    return res;
  } catch (error) {
    return errorResponse(error);
  }
}
