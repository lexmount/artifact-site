// POST /api/auth/logout — revoke this browser's session.
import { NextResponse } from "next/server";
import { clearSessionCookie, endSession, isSameOrigin } from "@/lib/session";
import { AuthError } from "@/lib/auth";
import { errorResponse, json } from "../../_util";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    // Cookie-authenticated write ⇒ Origin must match exactly. A missing or "null" Origin is
    // rejected, not waved through (a sandboxed preview iframe sends exactly Origin: null).
    if (!isSameOrigin(request)) throw new AuthError("Cross-site request rejected");
    await endSession(request);
    const res = json({ ok: true }, 200);
    res.headers.append("set-cookie", clearSessionCookie(request));
    return res;
  } catch (error) {
    return errorResponse(error);
  }
}
