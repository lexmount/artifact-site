// POST /oauth/register — RFC 7591 dynamic client registration, for MCP clients that do not use a
// client metadata document. Open by design (registering proves nothing and grants nothing — only
// a signed-in person on the consent page does), rate-limited, and switchable off with
// ARTIFACT_OAUTH_DCR=off, in which case the discovery document does not advertise it either.
import { rateLimit } from "@/lib/config";
import { noStoreJson, oauthErrorResponse, readBounded } from "@/lib/oauth";
import { registerOauthClient } from "@/lib/oauth-clients";
import { OauthError, discoveryPreflight } from "@/lib/oauth-shared";
import { checkRateLimit, clientKey } from "@/lib/ratelimit";
import { policy } from "@/lib/settings";

export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = 16 * 1024;

export async function POST(request: Request): Promise<Response> {
  try {
    if (!policy.oauth.dcrEnabled) throw new OauthError("invalid_client_metadata", "Dynamic client registration is disabled on this server; use a client metadata document", 404);
    checkRateLimit(request, Date.now(), `oauth-register:${clientKey(request)}`, rateLimit.burst, rateLimit.perMin);
    // Bounded while streaming, like the token endpoint: unauthenticated, so the ceiling bites on bytes.
    const text = await readBounded(request, MAX_BODY_BYTES);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new OauthError("invalid_client_metadata", "The registration request is not valid JSON");
    }
    const { registration } = await registerOauthClient(body);
    return noStoreJson(registration, 201);
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
