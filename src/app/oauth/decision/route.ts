// POST /oauth/decision — the consent page's answer: allow mints the authorization code and sends
// the browser back to the application; deny sends it back with access_denied.
//
// Strictly browser-only, like /device/approve: same-origin required (this IS a cookie-
// authenticated write), and a token session is refused outright — a leaked credential must not
// be able to approve an application for itself. The request id in the form is the CSRF token
// too: unguessable, minted for this account, answered exactly once.
import { NextResponse } from "next/server";
import { AuthError } from "@/lib/auth";
import { authorizationFailurePage, decideAuthorization } from "@/lib/oauth";
import { issuerFor } from "@/lib/oauth-shared";
import { isTokenSession } from "@/lib/publish-token";
import { checkRateLimit } from "@/lib/ratelimit";
import { isSameOrigin, resolveSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    checkRateLimit(request);
    if (!isSameOrigin(request)) throw new AuthError("Cross-site request rejected");
    const session = await resolveSession(request);
    if (!session) throw new AuthError("Please sign in first");
    if (isTokenSession(session)) throw new AuthError("A token cannot answer an authorization request; sign in in the browser");
    const form = await request.formData();
    const requestId = String(form.get("request") ?? "");
    const decision = form.get("decision") === "allow" ? "allow" : "deny";
    const { location } = await decideAuthorization({ requestId, decision }, session, issuerFor(request));
    // 303: the browser follows with a GET, whatever it did to get here.
    return new NextResponse(null, { status: 303, headers: { location, "cache-control": "no-store" } });
  } catch (error) {
    return authorizationFailurePage(error);
  }
}

export function GET(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
