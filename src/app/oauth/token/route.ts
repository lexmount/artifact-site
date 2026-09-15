// POST /oauth/token — RFC 6749 §3.2: an authorization code (with its PKCE verifier) or a refresh
// token in, an access + refresh token pair out. The client authenticates per its registration;
// public clients — every metadata-document client, ChatGPT included — rely on PKCE alone.
import { rateLimit } from "@/lib/config";
import { exchangeAuthorizationCode, noStoreJson, oauthErrorResponse, readTokenRequest, refreshTokens } from "@/lib/oauth";
import { authenticateClient } from "@/lib/oauth-clients";
import { OauthError, discoveryPreflight, issuerFor } from "@/lib/oauth-shared";
import { checkRateLimit, clientKey } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    // Unauthenticated until the client is resolved, and every call costs a lookup: budgeted per address.
    checkRateLimit(request, Date.now(), `oauth-token:${clientKey(request)}`, rateLimit.burst, rateLimit.perMin);
    const body = await readTokenRequest(request);
    const client = await authenticateClient(request, body);
    const issuer = issuerFor(request);
    const grantType = body.get("grant_type");
    if (grantType === "authorization_code") {
      return noStoreJson(await exchangeAuthorizationCode(client, {
        code: body.get("code"), codeVerifier: body.get("code_verifier"), redirectUri: body.get("redirect_uri"), resource: body.get("resource"),
      }, issuer));
    }
    if (grantType === "refresh_token") {
      return noStoreJson(await refreshTokens(client, { refreshToken: body.get("refresh_token"), scope: body.get("scope"), resource: body.get("resource") }, issuer));
    }
    throw new OauthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  } catch (error) {
    return oauthErrorResponse(error);
  }
}

export function OPTIONS(): Response {
  return discoveryPreflight();
}

export function GET(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST, OPTIONS" } });
}
