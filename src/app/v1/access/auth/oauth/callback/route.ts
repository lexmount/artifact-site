// GET /v1/access/auth/oauth/callback — alias for the OIDC redirect target.
//
// It exists because a redirect URI is registered in the IdP by an administrator, and that
// registration is not always the operator's to change: some were made against this path before
// the canonical one existed. Rather than block on someone else's console, such a deployment
// points ARTIFACT_OIDC_REDIRECT_PATH here and the same handler answers.
//
// Both paths run the identical handler, so this is not a weaker door: state is still a one-shot
// server-side flow id echoed in a `__Host-` cookie (Path=/, hence readable here too), the id_token
// is still verified against the issuer's JWKS, and the flow row is still consumed atomically.
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
