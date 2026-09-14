// GET /api/auth/callback — the canonical IdP redirect target. The behaviour lives in
// lib/oidc-callback so the alias route (see config.oidcRedirectPath) runs exactly the same checks.
import type { NextResponse } from "next/server";
import { handleOidcCallback, oidcFailureResponse } from "@/lib/oidc-callback";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    return await handleOidcCallback(request);
  } catch (error) {
    // A browser navigation, not an API call: answer failures with a page, not bare JSON.
    return oidcFailureResponse(error);
  }
}
