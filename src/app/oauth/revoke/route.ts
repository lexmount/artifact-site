// POST /oauth/revoke — RFC 7009. A client hands back a token it no longer wants (ChatGPT does this
// when a connector is removed). A refresh token ends the whole grant; an access token only itself.
// Always 200: a token that was never valid is exactly as revoked as one that just became so.
import { rateLimit } from "@/lib/config";
import { oauthErrorResponse, readTokenRequest, revokeToken } from "@/lib/oauth";
import { authenticateClient } from "@/lib/oauth-clients";
import { DISCOVERY_CORS_HEADERS, discoveryPreflight } from "@/lib/oauth-shared";
import { checkRateLimit, clientKey } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    checkRateLimit(request, Date.now(), `oauth-revoke:${clientKey(request)}`, rateLimit.burst, rateLimit.perMin);
    const body = await readTokenRequest(request);
    const client = await authenticateClient(request, body);
    await revokeToken(client, body.get("token"));
    return new Response(null, { status: 200, headers: { ...DISCOVERY_CORS_HEADERS, "cache-control": "no-store" } });
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
