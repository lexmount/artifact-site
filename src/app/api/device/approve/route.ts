// POST /api/device/approve — the human's side: a signed-in browser blesses a pending grant.
//
// Strictly browser-only: same-origin required (this IS a cookie-authenticated write), and a
// publish-token session is refused outright — otherwise a leaked token could approve itself a
// fresh replacement and survive its own revocation.
import type { NextResponse } from "next/server";
import { approveDeviceGrant } from "@/lib/db";
import { AuthError } from "@/lib/auth";
import { isSameOrigin, resolveSession } from "@/lib/session";
import { checkRateLimit } from "@/lib/ratelimit";
import { errorResponse, json } from "../../_util";

/** Accept what a human actually types: any case, hyphen or not → canonical XXXX-XXXX. */
function normalizeUserCode(raw: string): string | null {
  const chars = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return chars.length === 8 ? `${chars.slice(0, 4)}-${chars.slice(4)}` : null;
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    checkRateLimit(request);
    if (!isSameOrigin(request)) throw new AuthError("Cross-site request rejected");
    const session = await resolveSession(request);
    if (!session) throw new AuthError("Please sign in first");
    if (session.id.startsWith("pt:")) throw new AuthError("A publish token cannot authorize new devices");

    const body = (await request.json().catch(() => ({}))) as { user_code?: unknown };
    const userCode = normalizeUserCode(typeof body.user_code === "string" ? body.user_code : "");
    if (!userCode) return json({ error: "Invalid code format: expected 8 letters or digits" }, 400);

    const ok = await approveDeviceGrant(userCode, session.userId);
    if (!ok) return json({ error: "The code is invalid, expired or already used", code: "code_invalid" }, 404);
    return json({ ok: true }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}
